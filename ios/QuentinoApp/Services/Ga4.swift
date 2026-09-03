import Foundation

/**
 Návštěvnost z Google Analytics přes Sequel (sequel.sh).

 Sesterský modul k `src/main/ga4.ts`. Google Data API by znamenalo projekt
 v Cloudu, OAuth a obnovování tokenů; Sequel je obyčejný MCP server přes
 HTTP s klíčem v hlavičce, takže z telefonu je to jedno volání.

 Ptá se **nejvýš jednou za 24 hodin** — návštěvnost se mezi dvěma otevřeními
 přehledu nezmění tak, aby to stálo za dotaz, a snímek se stejně sdílí
 s ostatními zařízeními spolu s postřehy.
 */
enum Ga4 {
    private static let defaultEndpoint = "https://api.sequel.sh/mcp"
    private static let snapshotKey = "ga4Snapshot"
    private static let everySeconds: TimeInterval = 24 * 3600

    static var endpoint: String {
        let value = (Store.setting("ga4Endpoint", defaultEndpoint) ?? defaultEndpoint)
            .trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? defaultEndpoint : value
    }
    static var key: String { Secrets.get("ga4SequelKey") ?? "" }
    static var enabled: Bool { Store.setting("ga4Enabled", "0") == "1" }
    static var isReady: Bool { enabled && !key.isEmpty }

    static func config() -> [String: Any] {
        var out: [String: Any] = [:]
        out["enabled"] = enabled
        out["hasKey"] = !key.isEmpty
        out["endpoint"] = endpoint
        out["lastAt"] = (Store.setting("ga4LastAt", "") ?? "").isEmpty ? NSNull() : Store.setting("ga4LastAt", "")!
        out["lastError"] = (Store.setting("ga4LastError", "") ?? "").isEmpty
            ? NSNull() : Store.setting("ga4LastError", "")!
        out["ready"] = isReady
        return out
    }

    static func save(_ patch: [String: Any]) -> [String: Any] {
        if let value = patch["enabled"] as? Bool { Store.setSetting("ga4Enabled", value ? "1" : "0") }
        if let value = patch["key"] as? String {
            let clean = value.trimmingCharacters(in: .whitespaces)
            if clean.isEmpty { Secrets.set("ga4SequelKey", "") } else { Secrets.set("ga4SequelKey", clean) }
        }
        if let value = patch["endpoint"] as? String {
            let clean = value.trimmingCharacters(in: .whitespaces)
            Store.setSetting("ga4Endpoint", clean.isEmpty ? defaultEndpoint : clean)
        }
        return config()
    }

    // MARK: - MCP přes HTTP

    private static var sessionId: String?
    private static var toolName: String?

    /**
     Jedno volání JSON-RPC.

     Server odpovídá buď JSONem, nebo proudem událostí — v proudu je několik
     řádků `data: {…}` a ten s naším `id` je odpověď.
     */
    private static func rpc(_ method: String, _ params: Any?, id: Int?) async throws -> Any? {
        guard !key.isEmpty else { throw BridgeError.message("Chybí klíč k Sequelu (Nastavení → AI).") }
        guard let url = URL(string: endpoint) else { throw BridgeError.message("Adresa Sequelu není platná.") }

        var body: [String: Any] = ["jsonrpc": "2.0", "method": method]
        if let params { body["params"] = params }
        if let id { body["id"] = id }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let sessionId { request.setValue(sessionId, forHTTPHeaderField: "Mcp-Session-Id") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        if let given = http?.value(forHTTPHeaderField: "Mcp-Session-Id"), !given.isEmpty { sessionId = given }

        let text = String(data: data, encoding: .utf8) ?? ""
        let status = http?.statusCode ?? 0
        if status >= 400 { throw BridgeError.message("Sequel: \(status) \(text.prefix(200))") }
        guard let id else { return nil }

        let type = http?.value(forHTTPHeaderField: "Content-Type") ?? ""
        if type.contains("text/event-stream") {
            var answer: [String: Any]?
            for line in text.split(separator: "\n") where line.hasPrefix("data:") {
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let chunk = payload.data(using: .utf8),
                      let one = (try? JSONSerialization.jsonObject(with: chunk)) as? [String: Any] else { continue }
                if (one["id"] as? Int) == id { answer = one }
            }
            guard let answer else { throw BridgeError.message("Sequel neposlal odpověď.") }
            if let error = answer["error"] as? [String: Any] {
                throw BridgeError.message("Sequel: \(error["message"] as? String ?? "chyba")")
            }
            return answer["result"]
        }

        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let error = parsed?["error"] as? [String: Any] {
            throw BridgeError.message("Sequel: \(error["message"] as? String ?? "chyba")")
        }
        return parsed?["result"]
    }

    /// Který nástroj se umí zeptat — jména se čtou, ne hádají
    private static func pickTool() async throws -> String {
        if let toolName { return toolName }
        let list = try await rpc("tools/list", [String: Any](), id: 3) as? [String: Any]
        let tools = list?["tools"] as? [[String: Any]] ?? []
        guard !tools.isEmpty else { throw BridgeError.message("Sequel nenabízí žádný nástroj.") }

        var chosen = tools[0]
        for one in tools {
            let text = "\(one["name"] as? String ?? "") \(one["description"] as? String ?? "")"
            if text.range(of: "query|ask|analytics|report|run",
                          options: [.regularExpression, .caseInsensitive]) != nil {
                chosen = one
                break
            }
        }
        let name = chosen["name"] as? String ?? ""
        guard !name.isEmpty else { throw BridgeError.message("Nástroj Sequelu nemá jméno.") }
        toolName = name
        return name
    }

    private static func textOf(_ result: Any?) -> String {
        guard let one = result as? [String: Any] else { return "" }
        var parts: [String] = []
        for block in (one["content"] as? [[String: Any]] ?? []) {
            if let text = block["text"] as? String { parts.append(text) }
        }
        if parts.isEmpty, let structured = one["structuredContent"],
           JSONSerialization.isValidJSONObject(structured),
           let data = try? JSONSerialization.data(withJSONObject: structured),
           let text = String(data: data, encoding: .utf8) {
            parts.append(text)
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Položí Sequelu otázku a vrátí odpověď jako text
    static func ask(_ question: String) async throws -> String {
        sessionId = nil
        var hello: [String: Any] = [:]
        hello["protocolVersion"] = "2025-06-18"
        hello["capabilities"] = [String: Any]()
        hello["clientInfo"] = ["name": "quentino-app", "version": "1.0"]
        _ = try await rpc("initialize", hello, id: 1)
        _ = try await rpc("notifications/initialized", [String: Any](), id: nil)

        let tool = try await pickTool()
        // Jak se jmenuje parametr, nevíme — pošle se pod obvyklými jmény naráz
        var args: [String: Any] = [:]
        for name in ["query", "question", "prompt", "sql"] { args[name] = question }
        var params: [String: Any] = [:]
        params["name"] = tool
        params["arguments"] = args

        let text = textOf(try await rpc("tools/call", params, id: 4))
        guard !text.isEmpty else { throw BridgeError.message("Sequel vrátil prázdnou odpověď.") }
        return text
    }

    // MARK: - Denní snímek

    private static let question = """
    Vrať čísla z Google Analytics 4 za dvě období: posledních 30 dní ("window") a předchozích 30 dní před nimi \
    ("prevWindow"). U každého období: sessions (návštěvy), users (uživatelé), purchases (počet nákupů / transakcí) \
    a revenue (tržba). Dále 5 nejsilnějších zdrojů návštěv za posledních 30 dní (session source / medium) s počtem \
    návštěv. Odpověz POUZE tímto JSONem, bez komentáře:
    {"window":{"sessions":0,"users":0,"purchases":0,"revenue":0},\
    "prevWindow":{"sessions":0,"users":0,"purchases":0,"revenue":0},\
    "sources":[{"name":"google / organic","sessions":0}]}
    """

    private static func number(_ value: Any?) -> Any {
        if let one = value as? Int { return one }
        if let one = value as? Double { return Int(one.rounded()) }
        if let text = value as? String {
            let clean = text.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: ",", with: ".")
            if let one = Double(clean) { return Int(one.rounded()) }
        }
        return NSNull()
    }

    private static func period(_ raw: Any?) -> [String: Any] {
        let one = raw as? [String: Any] ?? [:]
        var out: [String: Any] = [:]
        out["sessions"] = number(one["sessions"])
        out["users"] = number(one["users"])
        out["purchases"] = number(one["purchases"] ?? one["transactions"])
        out["revenue"] = number(one["revenue"])
        return out
    }

    private static func conversion(_ period: [String: Any]) -> Any {
        guard let sessions = period["sessions"] as? Int, sessions > 0,
              let purchases = period["purchases"] as? Int else { return NSNull() }
        return (Double(purchases) / Double(sessions) * 1000).rounded() / 10
    }

    private static func stored() -> [String: Any]? {
        guard let text = Store.setting(snapshotKey, ""), !text.isEmpty,
              let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /**
     Návštěvnost za posledních třicet dní.

     Když se dotaz nepovede, vrátí se poslední známý snímek i s poznámkou,
     proč je starý — prázdná karta by neřekla nic.
     */
    static func snapshot(force: Bool = false) async -> [String: Any]? {
        guard isReady else { return nil }
        let last = stored()
        let lastAt = last?["at"] as? String ?? ""
        let age = lastAt.isEmpty ? Double.greatestFiniteMagnitude
            : Date().timeIntervalSince(Formats.date(lastAt) ?? Date(timeIntervalSince1970: 0))
        if !force, let last, age < everySeconds { return last }

        do {
            let text = try await ask(question)
            var parsed: [String: Any] = [:]
            if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
               let data = String(text[start...end]).data(using: .utf8),
               let one = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                parsed = one
            }

            let window = period(parsed["window"])
            let prev = period(parsed["prevWindow"])
            var sources: [[String: Any]] = []
            for row in (parsed["sources"] as? [[String: Any]] ?? []).prefix(5) {
                let name = (row["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                if name.isEmpty { continue }
                var one: [String: Any] = [:]
                one["name"] = name
                one["sessions"] = number(row["sessions"]) as? Int ?? 0
                sources.append(one)
            }

            var out: [String: Any] = [:]
            out["at"] = Formats.iso(Date())
            out["window"] = window
            out["prevWindow"] = prev
            out["sources"] = sources
            out["conversion"] = conversion(window)
            out["prevConversion"] = conversion(prev)
            out["text"] = String(text.prefix(2000))
            out["error"] = NSNull()

            if let json = OrderFeed.jsonText(out) { Store.setSetting(snapshotKey, json) }
            Store.setSetting("ga4LastAt", out["at"] as? String ?? "")
            Store.setSetting("ga4LastError", "")
            return out
        } catch {
            let message = error.localizedDescription
            Store.setSetting("ga4LastError", message)
            if var last {
                last["error"] = message
                return last
            }
            var out: [String: Any] = [:]
            out["at"] = ""
            out["window"] = period(nil)
            out["prevWindow"] = period(nil)
            out["sources"] = [[String: Any]]()
            out["conversion"] = NSNull()
            out["prevConversion"] = NSNull()
            out["text"] = ""
            out["error"] = message
            return out
        }
    }

    /// Zkouška spojení do nastavení
    static func test() async throws -> String {
        guard let snapshot = await snapshot(force: true) else {
            throw BridgeError.message("GA4 není zapnuté nebo chybí klíč.")
        }
        if let error = snapshot["error"] as? String { throw BridgeError.message(error) }
        let window = snapshot["window"] as? [String: Any] ?? [:]
        if let sessions = window["sessions"] as? Int {
            return "Spojení funguje — za posledních 30 dní \(sessions) návštěv."
        }
        let text = snapshot["text"] as? String ?? ""
        return "Spojení funguje, ale čísla se nepodařilo přečíst. Odpověď: \(text.prefix(160))"
    }
}
