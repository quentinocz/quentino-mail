import Foundation

/**
 Zákaznický chat z e-shopu.

 Mluví se stejnou databází jako webový admin — přes Supabase REST s veřejným
 (anon) klíčem. Do nasazeného chatu se nijak nezasahuje, aplikace je jen další
 klient. Logika je překlopená ze stolní verze včetně toho, jak se poznává,
 co je nepřečtené: rozhoduje poslední zpráva, ne počítadlo.
 */
enum Chat {
    // MARK: - Nastavení

    static var url: String { (Store.setting("chatSupabaseUrl", "") ?? "").trimmedSlash }
    static var apiBase: String { (Store.setting("chatApiBase", "") ?? "").trimmedSlash }
    static var anonKey: String { Secrets.get("chatAnonKey") ?? "" }
    static var isReady: Bool { !url.isEmpty && !anonKey.isEmpty }

    static func config() -> [String: Any] {
        [
            "url": url,
            "hasKey": !anonKey.isEmpty,
            "apiBase": apiBase,
            "ready": isReady,
            "operatorPersonId": Int(Store.setting("chatOperatorPersonId", "0") ?? "0") ?? 0,
            "signMode": Store.setting("chatSignMode", "first") ?? "first",
            "signSuffix": Store.setting("chatSignSuffix", "Quentino") ?? "Quentino"
        ]
    }

    static func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        if let value = patch["url"] as? String { Store.setSetting("chatSupabaseUrl", value.trimmedSlash) }
        if let value = patch["apiBase"] as? String { Store.setSetting("chatApiBase", value.trimmedSlash) }
        if let value = patch["anonKey"] as? String, !value.isEmpty { Secrets.set("chatAnonKey", value) }
        if let value = patch["operatorPersonId"] as? Int { Store.setSetting("chatOperatorPersonId", String(value)) }
        if patch["operatorPersonId"] is NSNull { Store.setSetting("chatOperatorPersonId", "0") }
        if let value = patch["signMode"] as? String { Store.setSetting("chatSignMode", value) }
        if let value = patch["signSuffix"] as? String { Store.setSetting("chatSignSuffix", value) }
        Store.touchState()
        return config()
    }

    // MARK: - Supabase REST

    private static func rest(
        _ path: String,
        method: String = "GET",
        body: Any? = nil
    ) async throws -> Any {
        guard isReady else {
            throw BridgeError.message("Chat není nastavený (Chat → Nastavení: adresa Supabase a anon klíč).")
        }
        var headers = [
            "apikey": anonKey,
            "Authorization": "Bearer \(anonKey)"
        ]
        if method != "GET" { headers["Prefer"] = "return=representation" }
        return try await Http.json("\(url)/rest/v1/\(path)", method: method, headers: headers, body: body)
    }

    // MARK: - Konverzace

    static func conversations(onlyOpen: Bool) async throws -> [[String: Any]] {
        let filter = onlyOpen ? "&status=eq.open" : ""
        // Poslední zpráva chodí rovnou s konverzací — vnořený výběr s vlastním
        // řazením a limitem, jeden dotaz místo dvou
        let rows = (try await rest(
            "conversations?select=*,messages(sender,created_at)"
            + "&messages.order=created_at.desc&messages.limit=1"
            + "&order=last_message_at.desc&limit=150\(filter)"
        )) as? [[String: Any]] ?? []

        var out: [[String: Any]] = []
        for row in rows {
            let last = (row["messages"] as? [[String: Any]])?.first?["sender"] as? String
            let counter = row["unread_operator"] as? Int ?? 0
            let unread: Int = {
                if let last, last != "customer" { return 0 }
                return counter > 0 ? counter : (last == "customer" ? 1 : 0)
            }()
            // Zapomenuté počítadlo srovnáme, ať se webový admin dívá na totéž
            if counter > 0, unread == 0, let id = row["id"] as? String {
                Task { try? await patch(id, ["unread_operator": 0]) }
            }
            out.append([
                "id": row["id"] ?? "",
                "sessionId": row["session_id"] ?? "",
                "status": row["status"] ?? "open",
                "name": row["customer_name"] ?? NSNull(),
                "email": row["customer_email"] ?? NSNull(),
                "phone": row["customer_phone"] ?? NSNull(),
                "locale": row["customer_locale"] ?? "cs",
                "lastMessageAt": row["last_message_at"] ?? "",
                "unread": unread,
                "channel": row["channel"] ?? "widget",
                "createdAt": row["created_at"] ?? "",
                "leftAt": row["left_at"] ?? NSNull(),
                "answered": (last != nil && last != "customer")
            ])
        }
        return out
    }

    static func messages(_ conversationId: String) async throws -> [[String: Any]] {
        let rows = (try await rest(
            "messages?select=*&conversation_id=eq.\(Http.escaped(conversationId))&order=created_at.asc&limit=500"
        )) as? [[String: Any]] ?? []
        return rows.map { row -> [String: Any] in
            [
                "id": row["id"] ?? "",
                "conversationId": row["conversation_id"] ?? "",
                "sender": row["sender"] ?? "customer",
                "content": row["content"] ?? "",
                "contentType": row["content_type"] ?? NSNull(),
                "createdAt": row["created_at"] ?? "",
                "readAt": row["read_at"] ?? NSNull()
            ]
        }
    }

    @discardableResult
    static func patch(_ conversationId: String, _ values: [String: Any]) async throws -> Any {
        try await rest("conversations?id=eq.\(Http.escaped(conversationId))", method: "PATCH", body: values)
    }

    static func markRead(_ conversationId: String) async throws {
        try await patch(conversationId, ["unread_operator": 0])
    }

    static func setStatus(_ conversationId: String, _ status: String) async throws {
        try await patch(conversationId, ["status": status])
    }

    static func unreadTotal() async throws -> [String: Any] {
        let list = try await conversations(onlyOpen: true)
        let unread = list.reduce(0) { $0 + ($1["unread"] as? Int ?? 0) }
        return ["unread": unread, "conversations": list.filter { ($0["unread"] as? Int ?? 0) > 0 }.count]
    }

    // MARK: - Odesílání

    /// Podpis „Petra, Quentino" — ve výchozím nastavení jen u první odpovědi.
    private static func signature(personId: Int?) -> String? {
        let settings = config()
        if personId == 0 { return nil }
        let id = personId ?? (settings["operatorPersonId"] as? Int ?? 0)
        guard id > 0, (settings["signMode"] as? String ?? "first") != "off" else { return nil }
        guard let person = Settings.persons().first(where: { ($0["id"] as? Int) == id }) else { return nil }
        let display = (person["displayNames"] as? [String: Any])?["cz"] as? String ?? ""
        let name = display.isEmpty ? (person["name"] as? String ?? "") : display
        guard let first = name.split(separator: " ").first else { return nil }
        let suffix = settings["signSuffix"] as? String ?? ""
        return suffix.isEmpty ? String(first) : "\(first), \(suffix)"
    }

    static func send(_ conversationId: String, _ text: String, personId: Int?) async throws -> [[String: Any]] {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { throw BridgeError.message("Zpráva je prázdná.") }

        var final = content
        if let sign = signature(personId: personId) {
            let history = try await messages(conversationId)
            let answeredBefore = history.contains { ($0["sender"] as? String) == "operator" }
            let mode = config()["signMode"] as? String ?? "first"
            if !content.hasSuffix(sign) && (mode == "always" || !answeredBefore) {
                final = "\(content)\n\n\(sign)"
            }
        }

        _ = try await rest("messages", method: "POST", body: [
            "conversation_id": conversationId, "content": final, "sender": "operator"
        ])
        try await patch(conversationId, ["last_message_at": ISO8601DateFormatter().string(from: Date())])
        try await markRead(conversationId)
        return try await messages(conversationId)
    }

    // MARK: - Produkty a karty

    static func productPreview(urls: [String]) async throws -> [[String: Any]] {
        guard !apiBase.isEmpty, !urls.isEmpty else { return [] }
        let joined = urls.prefix(6).joined(separator: ",")
        let rows = try await Http.array("\(apiBase)/api/chat/product-preview?urls=\(Http.escaped(joined))")
        return rows.map(normalizeProduct)
    }

    static func searchProducts(_ query: String) async throws -> [[String: Any]] {
        guard !apiBase.isEmpty, query.trimmingCharacters(in: .whitespaces).count >= 2 else { return [] }
        let rows = try await Http.array("\(apiBase)/api/chat/product-preview?search=\(Http.escaped(query))")
        return rows.map(normalizeProduct)
    }

    static func product(id: String, domain: String) async throws -> Any {
        guard !apiBase.isEmpty else { return NSNull() }
        let rows = try await Http.array(
            "\(apiBase)/api/chat/product-preview?id=\(Http.escaped(id))&domain=\(domain)"
        )
        guard let first = rows.first else { return NSNull() }
        return normalizeProduct(first)
    }

    private static func normalizeProduct(_ row: [String: Any]) -> [String: Any] {
        [
            "id": row["id"] ?? "",
            "name": row["name"] ?? "",
            "price": row["price"] ?? "",
            "imgUrl": row["imgUrl"] ?? "",
            "url": row["url"] ?? "",
            "domain": row["domain"] ?? ""
        ]
    }

    /// Adresy produktů ve zprávě — stejná pravidla jako ve widgetu.
    static func extractUrls(_ text: String) -> [String] {
        let pattern = #"https?://(?:www\.)?(?:quentino\.cz|quentino\.sk|wearquentino\.com)/[^\s<>"']*"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap {
            Range($0.range, in: text).map { String(text[$0]) }
        }
    }

    // MARK: - Návrh odpovědi

    static func suggest(_ conversationId: String, note: String) async throws -> String {
        let history = try await messages(conversationId)
        let conversation = (try await conversations(onlyOpen: false)).first { ($0["id"] as? String) == conversationId }
        let locale = conversation?["locale"] as? String ?? "cs"
        let languageName = ["cs": "česky", "sk": "slovensky", "en": "anglicky"][locale] ?? "česky"

        let knowledge = Settings.knowledge()
            .map { "\($0["title"] ?? ""): \($0["content"] ?? "")" }
            .joined(separator: "\n\n")
            .prefix(12_000)

        let transcript = history.suffix(25).map { message -> String in
            let who = (message["sender"] as? String) == "operator" ? "My"
                : (message["sender"] as? String) == "system" ? "Systém" : "Zákazník"
            return "\(who): \(message["content"] as? String ?? "")"
        }.joined(separator: "\n")

        var system = [
            Store.setting("brandPrompt", "") ?? "",
            "",
            "Píšeš odpovědi do živého chatu na e-shopu, ne e-maily.",
            "Odpovídej \(languageName) — jazykem, kterým píše zákazník.",
            "Drž se do tří vět. Žádné oslovení, žádný podpis, žádný pozdrav na konci.",
            "Když něco nevíš jistě, řekni to a nabídni, že to zjistíš.",
            "Nikdy si nevymýšlej ceny, termíny dodání ani dostupnost."
        ].joined(separator: "\n")
        let contact = Store.setting("contactInfo", "") ?? ""
        if !contact.isEmpty { system += "\n\nKONTAKTNÍ ÚDAJE\n\(contact)" }
        if !knowledge.isEmpty { system += "\n\nZNALOSTNÍ BÁZE\n\(knowledge)" }

        var user = "PRŮBĚH KONVERZACE\n\(transcript.isEmpty ? "(zatím nic)" : transcript)"
        if !note.trimmingCharacters(in: .whitespaces).isEmpty {
            user += "\n\nCO MÁ ODPOVĚĎ ŘÍCT\n\(note)"
        }
        user += "\n\nNapiš jen text odpovědi, nic jiného."

        return try await AI.ask(model: AI.draftModel, system: system, user: user, maxTokens: 600)
    }
}

extension String {
    /// Adresa bez koncových lomítek — ať se cesty neskládají se dvěma.
    var trimmedSlash: String {
        var value = trimmingCharacters(in: .whitespaces)
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}
