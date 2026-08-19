import Foundation

/**
 Generování popisků.

 Prompt se skládá na jednom místě, aby šlo dohledat, proč model napsal to, co
 napsal. Vstupem je profil značky, popis trhů a buď hotový český text (přepis
 existujícího příspěvku), nebo zadání pro nový. Obrázky se modelu posílají
 s sebou, takže popisek může reagovat na to, co je na fotce.

 Prompt je slovo od slova stejný jako na počítači — jinak by texty ze dvou
 zařízení zněly jinak.
 */
enum IgCaptions {
    struct Input {
        var mode: String        // "brief" nebo "source"
        var brief: String
        var source: String
        var mediaNote: String
        var langs: [String]
        var variants: Int
        /// Obrázky jako base64 bez prefixu `data:`
        var images: [(mime: String, base64: String)]
    }

    static func prompt(_ input: Input, brand: [String: Any], markets: [[String: Any]], knowledge: String) -> String {
        let marketBlock = input.langs
            .compactMap { lang in markets.first { ($0["lang"] as? String) == lang } }
            .map { market -> String in
                let tags = (market["tags"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let extra = tags.isEmpty ? "" : " Hashtagy k dispozici: \(tags)"
                return "\(market["lang"] as? String ?? "") (\(market["label"] as? String ?? "")): "
                    + "\(market["note"] as? String ?? "")\(extra)"
            }
            .joined(separator: "\n")

        var parts: [String] = [
            "Jsi copywriter značky Quentino a píšeš popisky pro Instagram.",
            "",
            "ZNAČKA",
            brand["context"] as? String ?? ""
        ]

        let love = (brand["love"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if (brand["loveOn"] as? Bool ?? false), !love.isEmpty {
            parts.append(contentsOf: ["", "PŘÍSTUP KE ZNAČCE", love])
        }
        if !knowledge.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(contentsOf: ["", "DOPLŇUJÍCÍ ZNALOSTI", knowledge])
        }

        let tones = (brand["tones"] as? [String] ?? []).joined(separator: ", ")
        parts.append(contentsOf: [
            "",
            "TÓN",
            tones.isEmpty ? "přirozený" : tones,
            "",
            "NIKDY",
            brand["avoid"] as? String ?? "",
            "",
            "TRHY",
            marketBlock.isEmpty ? input.langs.joined(separator: ", ") : marketBlock
        ])

        parts.append("")
        parts.append(input.mode == "source"
            ? "HOTOVÝ ČESKÝ TEXT K PŘEPSÁNÍ\n\"\"\"\(input.source)\"\"\""
            : "ZADÁNÍ\n\"\"\"\(input.brief)\"\"\"")

        if !input.mediaNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append(contentsOf: ["", "K MÉDIÍM", input.mediaNote])
        }

        let emojiRule: String
        switch brand["emoji"] as? String ?? "sparse" {
        case "none": emojiRule = "Nepoužívej emoji."
        case "free": emojiRule = "Emoji používej, kde se hodí — ale ne v každé větě a nikdy místo slova, které něco říká."
        default: emojiRule = "Emoji používej velmi střídmě: nejvýš jedno až dvě na popisek, a jen když opravdu něco přidají."
        }

        parts.append(contentsOf: [
            "",
            "PRAVIDLA",
            brand["rules"] as? String ?? "",
            emojiRule,
            "Nepřekládej doslova — piš tak, jak by to napsal rodilý mluvčí daného trhu.",
            "Popisek nesmí přesáhnout 2 200 znaků ani 30 hashtagů.",
            "",
            "Napiš popisek pro tyto trhy: \(input.langs.joined(separator: ", ")).",
            input.variants > 1
                ? "Pro každý trh vytvoř \(input.variants) různé varianty — ne přeformulování téže věty, "
                    + "ale jiný úhel: jiný začátek, jiná délka, jiný důraz."
                : "Pro každý trh vytvoř jednu variantu.",
            "",
            "Vrať POUZE JSON ve tvaru {\"KÓD_TRHU\": [\"varianta 1\", \"varianta 2\"]} bez dalšího textu, "
                + "pro každý z těchto klíčů: \(input.langs.joined(separator: ", "))."
        ])

        return parts.joined(separator: "\n")
    }

    static func generate(_ input: Input) async throws -> [(lang: String, variants: [String])] {
        guard !input.langs.isEmpty else { throw BridgeError.message("Není vybraný žádný trh.") }
        if input.mode == "brief", input.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw BridgeError.message("Napiš zadání, o čem má příspěvek být.")
        }
        if input.mode == "source", input.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw BridgeError.message("Původní příspěvek nemá text k přepsání.")
        }

        let brand = IgStore.brand()
        let knowledge = (brand["useKnowledge"] as? Bool ?? false)
            ? String(Settings.knowledge()
                .map { "\($0["title"] as? String ?? ""): \($0["content"] as? String ?? "")" }
                .joined(separator: "\n\n")
                .prefix(12_000))
            : ""

        let text = prompt(input, brand: brand, markets: IgStore.markets(), knowledge: knowledge)

        var content: [[String: Any]] = input.images.prefix(6).map { image in
            ["type": "image", "source": ["type": "base64", "media_type": image.mime, "data": image.base64]]
        }
        content.append(["type": "text", "text": text])

        let answer = try await AI.ask(model: AI.draftModel, system: nil, content: content, maxTokens: 3000)
        let parsed = try parseJson(answer)

        let captions: [(lang: String, variants: [String])] = input.langs.map { lang in
            let raw = parsed[lang] ?? parsed[lang.lowercased()] ?? parsed[lang.uppercased()]
            var list: [String] = []
            if let array = raw as? [Any] {
                list = array.map { String(describing: $0).trimmingCharacters(in: .whitespacesAndNewlines) }
            } else if let single = raw as? String {
                list = [single.trimmingCharacters(in: .whitespacesAndNewlines)]
            }
            return (lang, list.filter { !$0.isEmpty })
        }

        let usable = captions.filter { !$0.variants.isEmpty }
        guard !usable.isEmpty else {
            throw BridgeError.message("Model nevrátil žádný použitelný text. Zkus generování znovu.")
        }
        return usable
    }

    /// Model občas obalí JSON do bloku se zpětnými apostrofy nebo přidá větu navíc.
    private static func parseJson(_ text: String) throws -> [String: Any] {
        let cleaned = text
            .replacingOccurrences(of: "```json", with: "", options: [.caseInsensitive])
            .replacingOccurrences(of: "```", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if let data = cleaned.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return parsed
        }
        if let start = cleaned.firstIndex(of: "{"), let end = cleaned.lastIndex(of: "}"), start < end {
            let slice = String(cleaned[start...end])
            if let data = slice.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return parsed
            }
        }
        throw BridgeError.message("Model nevrátil použitelný JSON. Zkus generování znovu.")
    }
}
