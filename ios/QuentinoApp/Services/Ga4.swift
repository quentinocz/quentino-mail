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
        /*
         Zdroj a seznam zdrojů. Bez nich okno nastavení na telefonu padalo:
         čte `apps.length`, a `undefined.length` shodí celé vykreslení do
         šedé plochy. Sequel má pod jedním klíčem víc zdrojů a u dotazu chce
         vědět který.
         */
        out["appId"] = Store.setting("ga4AppId", "") ?? ""
        var apps: [[String: Any]] = []
        if let raw = Store.setting("ga4Apps", "[]"), let data = raw.data(using: .utf8),
           let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            apps = list
        }
        out["apps"] = apps
        return out
    }

    /// Poslední celá odpověď Sequelu — do nastavení, když se dotaz nepovedl
    static func lastDetail() -> String {
        let value = Store.setting("ga4LastDetail", "") ?? ""
        return value.isEmpty ? "Zatím se nic neuložilo." : value
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
        if let value = patch["appId"] as? String {
            Store.setSetting("ga4AppId", value.trimmingCharacters(in: .whitespaces))
        }
        return config()
    }

    // MARK: - MCP přes HTTP

    private static var sessionId: String?

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

        /*
         Spojení se svým stropem a jedním opakováním.

         Sequel na dotaz do Google Analytics klidně počítá minutu a spojení
         se mezitím rozpadne — z toho v okně bylo holé „fetch failed", ve
         kterém není ani adresa, ani důvod. Strop jsou dvě minuty a jedno
         klopýtnutí sítě se zkusí znovu; druhý pokus obvykle projde.
         */
        request.timeoutInterval = 120
        var data: Data
        var response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            do {
                (data, response) = try await URLSession.shared.data(for: request)
            } catch let again {
                /*
                 Nenavázané spojení není chyba nastavení. Rada „zkontroluj
                 adresu" je tu k ničemu: server buď neběží, nebo se k němu
                 tahle síť nedostane.
                 */
                let why = again.localizedDescription
                let code = (again as NSError).code
                let unreachable = [NSURLErrorTimedOut, NSURLErrorCannotConnectToHost,
                                   NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost,
                                   NSURLErrorNotConnectedToInternet].contains(code)
                throw BridgeError.message(
                    unreachable
                        ? "Server \(url.host ?? endpoint) se neozval (\(why)) Buď je dočasně nedostupný,"
                          + " nebo se k němu tahle síť nedostane — zkus to za chvíli."
                        : "Nepodařilo se spojit se Sequelem (\(url.host ?? endpoint)): \(why)"
                          + " Zkontroluj internet a adresu v nastavení.")
            }
        }
        let http = response as? HTTPURLResponse
        if let given = http?.value(forHTTPHeaderField: "Mcp-Session-Id"), !given.isEmpty { sessionId = given }

        let text = String(data: data, encoding: .utf8) ?? ""
        let status = http?.statusCode ?? 0
        /*
         Stavový kód se vyplatí přeložit do češtiny. „404" u koncového bodu
         neznamená chybu dat, ale že na téhle adrese MCP vůbec není — a „401"
         že neplatí klíč. Bez toho se obojí čte jako záhadné číslo.
         */
        if status == 404 || status == 405 {
            throw BridgeError.message(
                "Na adrese \(endpoint) žádné MCP není (\(status)). Zkontroluj adresu koncového bodu"
                + " v nastavení — Sequel ji ukazuje u napojení.")
        }
        if status == 401 || status == 403 {
            throw BridgeError.message("Sequel klíč nepřijal (\(status)) — vlož nový v nastavení.")
        }
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

    /**
     Nástroje, které server nabízí — i s tím, co po nás chtějí.

     Hádat jména parametrů byla chyba: Sequel má u dotazu i `action` (co se
     má stát) a `app_id` (kterého zdroje se to týká), takže dotaz poslaný jen
     s textem otázky skončil hláškou „app_id is required when
     action='connect'". Schéma každého nástroje ale MCP posílá spolu s ním.
     */
    private static func listTools() async throws -> [[String: Any]] {
        let list = try await rpc("tools/list", [String: Any](), id: 3) as? [String: Any]
        let tools = list?["tools"] as? [[String: Any]] ?? []
        guard !tools.isEmpty else { throw BridgeError.message("Sequel nenabízí žádný nástroj.") }
        return tools
    }

    private static func schemaOf(_ tool: [String: Any]) -> [String: Any] {
        (tool["inputSchema"] as? [String: Any]) ?? (tool["input_schema"] as? [String: Any]) ?? [:]
    }

    /*
     Sequel nabízí víc nástrojů a jeden z nich je **správce spojení**
     (`sequel_manage_connections`) — ten umí jen list, connect a reconnect.
     Přesně na něm napojení uvázlo: vybral se jako dotazovací a žádná jeho
     akce nevypadala jako dotaz. Rozhoduje proto schéma, ne jméno: nástroj,
     který se umí zeptat, má v parametrech místo pro otázku.
     */
    private static let manages = "manage|connection|auth|admin|setup|install|integration"

    private static func asksQuestion(_ tool: [String: Any]) -> Bool {
        let properties = schemaOf(tool)["properties"] as? [String: Any] ?? [:]
        return properties.keys.contains { $0.range(of: asksQuestionPattern, options: [.regularExpression, .caseInsensitive]) != nil }
    }

    /// Nástroj, který se umí zeptat na data
    private static func queryTool(_ tools: [[String: Any]]) -> [String: Any] {
        let usable = tools.filter {
            ($0["name"] as? String ?? "").range(
                of: manages, options: [.regularExpression, .caseInsensitive]) == nil
        }
        if let found = usable.first(where: { asksQuestion($0) }) { return found }
        if let found = tools.first(where: { asksQuestion($0) }) { return found }
        for one in usable {
            let text = "\(one["name"] as? String ?? "") \(one["description"] as? String ?? "")"
            if text.range(of: "query|ask|analytics|report|run|sql|data",
                          options: [.regularExpression, .caseInsensitive]) != nil {
                return one
            }
        }
        return usable.first ?? tools[0]
    }

    /// Nástroj, který vypíše napojené zdroje — u Sequelu je to správce spojení
    private static func listTool(_ tools: [[String: Any]]) -> [String: Any] {
        if let found = tools.first(where: {
            ($0["name"] as? String ?? "").range(
                of: manages, options: [.regularExpression, .caseInsensitive]) != nil
        }) { return found }
        if let found = tools.first(where: {
            "\($0["name"] as? String ?? "") \($0["description"] as? String ?? "")".range(
                of: "app|source|connection|integration|list",
                options: [.regularExpression, .caseInsensitive]) != nil
        }) { return found }
        return queryTool(tools)
    }

    /**
     Nástroj, který dotaz teprve **spustí**.

     Sequel nemá jeden nástroj na dotaz, ale dva kroky: hledání řekne, co se
     s napojeným zdrojem dá dělat, a spuštění to provede — hledání samo
     čísla nevrátí. Pozná se podle `tool_calls` v parametrech.
     */
    private static func runTool(_ tools: [[String: Any]]) -> [String: Any]? {
        tools.first { tool in
            let properties = schemaOf(tool)["properties"] as? [String: Any] ?? [:]
            return properties.keys.contains {
                $0.range(of: "^(tool_?calls|calls|steps|plan)$",
                         options: [.regularExpression, .caseInsensitive]) != nil
            }
        }
    }

    /// Jména parametrů, do kterých patří otázka, zdroj a věta „proč se ptáme"
    private static let asksQuestionPattern =
        "^(query|question|prompt|q|text|input|message|request|task|use_?case|goal|objective|ask)$"
    private static let asksAppPattern =
        "^(app|application|source|connection|integration|database|datasource)_?ids?$"
    private static let asksWhyPattern =
        "^(action_?info|reason|purpose|why|description|note|context|intent)$"
    /// Sequel chce u každého nástroje větu, proč se ptáme — bez ní dotaz odmítne
    static let whyWeAsk = "Denní přehled e-shopu Quentino — návštěvnost za posledních 30 dní."

    /*
     Sequel má jeden nástroj a v něm výčet akcí: `connect` naváže spojení,
     `list` vypíše napojené zdroje a teprve něco třetího se doopravdy ptá.
     Když se pošle `list`, server ochotně odpoví seznamem spojení — a z toho
     byly v přehledu samé nuly.
     */
    private static let queryActions = [
        "query", "run_query", "execute_query", "sql_query", "run_sql", "ask",
        "run", "execute", "search", "report", "analytics", "fetch", "read", "sql", "data"
    ]
    private static let listActions = [
        "list_apps", "list_sources", "list_connections", "apps", "sources", "connections", "list"
    ]
    /// Akce, které nikdy nevrátí data
    /*
     Kotva na začátku tady byla chyba: `reconnect` jí prošel, poslal se jako
     dotaz a Sequel odpověděl `{"action":"reconnect","status":"pending"}` —
     což vypadalo jako odpověď a v přehledu z toho nebylo nic.
     */
    private static let neverQuery =
        "(connect|disconnect|list|describe|schema|tables|status|health|ping|auth|oauth"
        + "|install|register|create|update|delete|remove|refresh|login|signin|token)"

    /// Akce, kterými má smysl se ptát — v pořadí, v jakém se zkusí
    private static func queryActionOptions(_ options: [String]) -> [String] {
        var out: [String] = []
        for want in queryActions {
            if let match = options.first(where: { $0.lowercased() == want }), !out.contains(match) {
                out.append(match)
            }
        }
        for one in options where !out.contains(one) {
            let isNever = one.range(of: neverQuery, options: [.regularExpression, .caseInsensitive]) != nil
            if isNever { continue }
            if queryActions.contains(where: { one.lowercased().contains($0) }) { out.append(one) }
        }
        for one in options where !out.contains(one) {
            if one.range(of: neverQuery, options: [.regularExpression, .caseInsensitive]) == nil { out.append(one) }
        }
        if !out.isEmpty { return out }

        /*
         Ani jedna akce nevypadá jako dotaz.

         Tohle už jednou zabolelo: seznam se přefiltroval do prázdna, smyčka
         neproběhla vůbec a v okně stálo „zkoušené akce: " — bez jediné akce
         a bez odpovědi, ze které by se dalo poznat proč. Zkusit se má
         vždycky něco: připojení a odpojení jsou jediné dvě, které opravdu
         nemají co vrátit.
         */
        let usable = options.filter {
            $0.trimmingCharacters(in: .whitespaces).range(
                of: "^(re)?connect$|^disconnect$",
                options: [.regularExpression, .caseInsensitive]) == nil
        }
        return usable.isEmpty ? options : usable
    }

    private static func listActionOption(_ options: [String]) -> String? {
        for want in listActions {
            if let match = options.first(where: { $0.lowercased() == want }) { return match }
        }
        return options.first { $0.range(of: "list|apps|sources|connections",
                                        options: [.regularExpression, .caseInsensitive]) != nil }
    }

    /// Argumenty podle schématu nástroje, ne podle domněnky
    private static func argsFor(_ tool: [String: Any], question: String?, appId: String?,
                                action: String) -> [String: Any] {
        let schema = schemaOf(tool)
        let properties = schema["properties"] as? [String: Any] ?? [:]
        let required = schema["required"] as? [String] ?? []
        var out: [String: Any] = [:]

        for (name, raw) in properties {
            let property = raw as? [String: Any] ?? [:]
            let options = enumOf(property)
            let lower = name.lowercased()

            if lower == "action", !options.isEmpty {
                let picked = action == "list" ? listActionOption(options) : queryActionOptions(options).first
                if let picked { out["action"] = picked }
                continue
            }
            // Pole se musí zabalit — `connection_ids` je pole, `connection_id` text
            let wantsArray = (property["type"] as? String) == "array"
            if let question, lower.range(of: asksQuestionPattern, options: .regularExpression) != nil {
                out[name] = wantsArray ? [question] : question
                continue
            }
            if let appId, !appId.isEmpty, lower.range(of: asksAppPattern, options: .regularExpression) != nil {
                out[name] = wantsArray ? [appId] : appId
                continue
            }
            // Povinná věta „proč se ptáme" — bez ní Sequel dotaz odmítne
            if lower.range(of: asksWhyPattern, options: .regularExpression) != nil, required.contains(name) {
                out[name] = whyWeAsk
                continue
            }
            if required.contains(name), !options.isEmpty, out[name] == nil { out[name] = options[0] }
        }

        // Schéma nemusí dorazit vůbec — pak se pošlou obvyklá jména
        if properties.isEmpty {
            if let question { out["query"] = question; out["question"] = question }
            if let appId, !appId.isEmpty { out["app_id"] = appId }
            out["action"] = action == "list" ? "list_apps" : "query"
        }
        return out
    }

    private static func connect() async throws {
        sessionId = nil
        var hello: [String: Any] = [:]
        hello["protocolVersion"] = "2025-06-18"
        hello["capabilities"] = [String: Any]()
        hello["clientInfo"] = ["name": "quentino-app", "version": "1.0"]
        _ = try await rpc("initialize", hello, id: 1)
        _ = try await rpc("notifications/initialized", [String: Any](), id: nil)
    }

    /// Které zdroje jsou pod klíčem napojené — jediný se vybere sám
    static func apps() async throws -> [[String: Any]] {
        try await connect()
        let tools = try await listTools()
        let lister = listTool(tools)

        var params: [String: Any] = [:]
        params["name"] = lister["name"] as? String ?? ""
        params["arguments"] = argsFor(lister, question: nil, appId: nil, action: "list")
        let text = textOf(try? await rpc("tools/call", params, id: 5))

        /*
         Spojení z odpovědi. Sequel je vrací jako `{"connections":[{"connection_id":
         "…","name":"GA4 — …","type":"google_analytics"}]}`, ale jistota to není —
         jiné verze mohou použít `app_id` nebo `id`. Hledá se proto v textu, ne
         v pevné cestě.
         */
        var found: [[String: Any]] = []
        var seen = Set<String>()

        /*
         Napojená spojení, ne nabídka. Odpověď nese vedle `connections` i
         `available_apps` — katalog toho, co by se dalo napojit (PostgreSQL,
         Stripe, HubSpot…). Bez rozlišení se do výběru dostalo šestnáct věcí,
         které nikdo nemá, a ta jediná skutečná se v nich ztratila.
         */
        if let listed = findArray(jsonIn(text), key: "connections"), !listed.isEmpty {
            for one in listed {
                let id = ((one["connection_id"] as? String) ?? (one["id"] as? String)
                    ?? (one["app_id"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
                if id.isEmpty || seen.contains(id) { continue }
                seen.insert(id)
                var entry: [String: Any] = [:]
                entry["id"] = id
                entry["name"] = (one["name"] as? String) ?? (one["title"] as? String) ?? id
                entry["type"] = (one["type"] as? String) ?? (one["app_id"] as? String) ?? ""
                found.append(entry)
            }
        }
        if !found.isEmpty { return finishApps(found) }

        let idKey = "(?:connection_?id|datasource_?id|source_?id|app_?id|id)"
        let nameKey = "(?:name|title|label|app_?name)"
        var search = text.startIndex..<text.endIndex
        while let range = text.range(of: "\"\(idKey)\"\\s*:\\s*\"[^\"]{1,64}\"[^}]{0,300}",
                                     options: [.regularExpression, .caseInsensitive], range: search) {
            let chunk = String(text[range])
            search = range.upperBound..<text.endIndex

            let parts = chunk.components(separatedBy: "\"")
            guard parts.count >= 4 else { continue }
            let id = parts[3]
            if id.isEmpty || seen.contains(id) { continue }
            seen.insert(id)

            let name = firstMatch(chunk, "\"\(nameKey)\"\\s*:\\s*\"([^\"]{1,80})\"") ?? id
            let type = firstMatch(chunk, "\"type\"\\s*:\\s*\"([^\"]{1,40})\"") ?? ""

            var one: [String: Any] = [:]
            one["id"] = id
            one["name"] = name
            one["type"] = type
            found.append(one)
        }

        return finishApps(found)
    }

    /**
     Uloží nalezené zdroje a vybere ten zřejmý.

     Vybírat se nemusí, když je jasno: jediný zdroj, nebo jediný, který je
     Google Analytics. Na návštěvnost se databáze skladu ptát nemá smysl,
     a Sequel u každého spojení hlásí `type`.
     */
    private static func finishApps(_ found: [[String: Any]]) -> [[String: Any]] {
        if !found.isEmpty, JSONSerialization.isValidJSONObject(found),
           let data = try? JSONSerialization.data(withJSONObject: found),
           let json = String(data: data, encoding: .utf8) {
            Store.setSetting("ga4Apps", json)
        }
        let analytics = found.filter { one in
            "\(one["type"] as? String ?? "") \(one["name"] as? String ?? "")"
                .range(of: "analytic|ga4", options: [.regularExpression, .caseInsensitive]) != nil
        }
        let obvious = analytics.count == 1 ? analytics.first : (found.count == 1 ? found.first : nil)
        if let obvious, (Store.setting("ga4AppId", "") ?? "").isEmpty {
            Store.setSetting("ga4AppId", obvious["id"] as? String ?? "")
        }
        return found
    }

    /// První skupina z regulárního výrazu — jen aby se to nepsalo pětkrát
    private static func firstMatch(_ text: String, _ pattern: String) -> String? {
        guard let range = text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else {
            return nil
        }
        let chunk = String(text[range])
        let parts = chunk.components(separatedBy: "\"")
        return parts.count >= 4 ? parts[3] : nil
    }

    /// Co server nabízí za nástroje — do nastavení, když se automatika netrefí
    static func diagnostics() async throws -> String {
        try await connect()
        let tools = try await listTools()
        return tools.map { one -> String in
            let schema = schemaOf(one)["properties"] as? [String: Any] ?? [:]
            let properties = schema.keys.sorted()
            let required = (schemaOf(one)["required"] as? [String] ?? []).joined(separator: ", ")
            let name = one["name"] as? String ?? ""
            let list = properties.isEmpty ? "—" : properties.joined(separator: ", ")
            /*
             Výčty patří do výpisu. Jméno parametru („action") neřekne nic;
             teprve jeho hodnoty ukážou, jestli tam vůbec je něco, čím se dá
             zeptat — a přesně na tom se napojení jednou zaseklo.
             */
            var enums: [String] = []
            for key in properties {
                let values = enumOf(schema[key])
                if !values.isEmpty { enums.append("\(key): \(values.joined(separator: " | "))") }
            }
            let head = "\(name)(\(list))" + (required.isEmpty ? "" : " · povinné: \(required)")
            return enums.isEmpty ? head : head + "\n    " + enums.joined(separator: "\n    ")
        }.joined(separator: "\n")
    }

    /// Největší JSON v textu — servery ho rády obalí větou
    private static func jsonIn(_ text: String) -> [String: Any]? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else {
            return nil
        }
        let slice = String(text[start...end])
        guard let data = slice.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Pole pod daným klíčem, ať je v odpovědi zanořené jakkoli hluboko
    private static func findArray(_ node: Any?, key: String, depth: Int = 0) -> [[String: Any]]? {
        guard depth <= 6, let map = node as? [String: Any] else { return nil }
        if let found = map[key] as? [[String: Any]] { return found }
        for value in map.values {
            if let found = findArray(value, key: key, depth: depth + 1) { return found }
        }
        return nil
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

    /**
     Položí Sequelu otázku a vrátí odpověď jako text.

     Argumenty se skládají podle schématu nástroje, ne podle domněnky —
     přesně kvůli tomu, na čem to dřív padalo: bez `action` a `app_id` si
     server domyslel `connect` a odpověděl „app_id is required".
     */
    static func ask(_ question: String) async throws -> String {
        try await connect()
        let tools = try await listTools()
        let tool = queryTool(tools)

        var appId = Store.setting("ga4AppId", "") ?? ""
        let properties = (schemaOf(tool)["properties"] as? [String: Any] ?? [:]).keys
        let needsApp = properties.contains { name in
            name.lowercased().range(
                of: "(app|application|source|connection|integration|database|datasource)_?id$",
                options: .regularExpression) != nil
        }
        if needsApp, appId.isEmpty {
            // Zdroj se nevybral — zkusí se dohledat, a když je jediný, použije se
            let found = try await apps()
            if found.count == 1 { appId = found[0]["id"] as? String ?? "" }
            else if found.count > 1 {
                let names = found.compactMap { $0["name"] as? String }.joined(separator: ", ")
                throw BridgeError.message("Sequel má víc zdrojů — vyber ten správný v nastavení: \(names)")
            }
            try await connect()
        }

        var params: [String: Any] = [:]
        /*
         Jak se u Sequelu jmenuje akce, která se doopravdy ptá, se z výčtu
         poznat nedá — `query`, `run_query`, `execute`… Zkusí se proto po
         řadě a odpověď se pokaždé přečte: když přišel **seznam spojení**,
         je to důkaz, že se poslala špatná akce (přesně z toho byly nuly),
         a jde se na další.
         */
        let actionOptions = enumOf((schemaOf(tool)["properties"] as? [String: Any] ?? [:])["action"])
        let candidates = actionOptions.isEmpty ? [""] : queryActionOptions(actionOptions)

        var last = ""
        var tried: [String] = []
        let offered = actionOptions.isEmpty ? "nástroj žádné akce nenabízí" : actionOptions.joined(separator: ", ")
        for (index, action) in candidates.prefix(4).enumerated() {
            var args = argsFor(tool, question: question, appId: appId, action: "query")
            if !action.isEmpty { args["action"] = action }
            tried.append(action.isEmpty ? (tool["name"] as? String ?? "nástroj") : action)
            params["name"] = tool["name"] as? String ?? ""
            params["arguments"] = args

            var text = textOf(try await rpc("tools/call", params, id: 4 + index))
            if text.isEmpty { last = "Sequel vrátil prázdnou odpověď."; continue }
            last = text
            if let reconnect = needsReconnect(text) { throw BridgeError.message(reconnect) }

            /*
             Návod k použití zdroje. `sequel_search` nevrací hotové kroky,
             ale výsledky hledání — a u nich číslo návodu (`skill_id`). Ten
             návod je jediné místo, kde je napsané, co se dá spustit.
             */
            let parsed = jsonIn(text)
            if let results = findArray(parsed, key: "results"),
               let skillId = results.compactMap({ ($0["skill_id"] as? String) ?? ($0["id"] as? String) }).first,
               let reader = tools.first(where: {
                   ($0["name"] as? String ?? "").range(
                       of: "read_skill|skill|docs|help",
                       options: [.regularExpression, .caseInsensitive]) != nil
               }) {
                var readArgs = argsFor(reader, question: question, appId: appId, action: "query")
                for name in (schemaOf(reader)["properties"] as? [String: Any] ?? [:]).keys
                where name.range(of: "skill_?id|doc_?id|id$", options: [.regularExpression, .caseInsensitive]) != nil {
                    readArgs[name] = skillId
                }
                var readParams: [String: Any] = [:]
                readParams["name"] = reader["name"] as? String ?? ""
                readParams["arguments"] = readArgs
                tried.append("\(reader["name"] as? String ?? "") (\(skillId))")
                /*
                 Návod je jen k pochopení, ne k výsledku — když se ho
                 nepodaří přečíst, nesmí to shodit celý dotaz. První krok
                 už proběhl a jeho odpověď se hodí víc než holá chyba sítě.
                 */
                let manual = (try? await rpc("tools/call", readParams, id: 60 + index))
                    .map { textOf($0) } ?? ""
                if !manual.isEmpty { last = text + "\n\n--- návod \(skillId) ---\n" + manual }
            }

            /*
             Druhý krok. Sequel na dotaz nejdřív odpoví návrhem, co spustit
             (`tool_calls`) — čísla v tom nejsou. Teprve spuštění je provede;
             bez tohohle kroku se v přehledu ukazoval plán místo dat.
             */
            if let plan = findArray(parsed, key: "tool_calls") ?? findArray(jsonIn(last), key: "tool_calls"),
               !plan.isEmpty,
               let runner = runTool(tools) {
                var runArgs = argsFor(runner, question: question, appId: appId, action: "query")
                let runProperties = schemaOf(runner)["properties"] as? [String: Any] ?? [:]
                for (name, raw) in runProperties {
                    let property = raw as? [String: Any] ?? [:]
                    let lower = name.lowercased()
                    if lower.range(of: "^(tool_?calls|calls|steps|plan)$", options: .regularExpression) != nil {
                        runArgs[name] = (property["type"] as? String) == "array"
                            ? plan
                            : (OrderFeed.jsonText(["calls": plan]) ?? "")
                    }
                    if lower.range(of: "^session_?id$", options: .regularExpression) != nil {
                        let session = (parsed?["session_id"] as? String)
                            ?? ((parsed?["data"] as? [String: Any])?["session_id"] as? String)
                        if let session, !session.isEmpty { runArgs[name] = session }
                    }
                }
                var runParams: [String: Any] = [:]
                runParams["name"] = runner["name"] as? String ?? ""
                runParams["arguments"] = runArgs
                tried.append(runner["name"] as? String ?? "spuštění")
                // Spuštění taky nesmí shodit celý dotaz — návrh z prvního
                // kroku je pořád k něčemu a v nastavení je vidět, kde to stálo
                let done = (try? await rpc("tools/call", runParams, id: 40 + index))
                    .map { textOf($0) } ?? ""
                if !done.isEmpty { text = done; last = done }
            }

            if looksLikeListing(text) { continue }
            if text.range(of: "\"status\"\\s*:\\s*\"error\"|\"error\"\\s*:\\s*\"",
                          options: .regularExpression) != nil { continue }
            return text
        }
        if let reconnect = needsReconnect(last) { throw BridgeError.message(reconnect) }

        /*
         Hláška se čte z bubliny na telefonu, takže musí být krátká a říct,
         co dál. Celá odpověď serveru se schová do nastavení — tam je na ni
         místo a dá se z ní poznat, co Sequel vlastně poslal.
         */
        let detail = [
            Formats.iso(Date()),
            "nástroj: \(tool["name"] as? String ?? "")",
            "nabízené akce: \(offered)",
            "zkoušené akce: \(tried.isEmpty ? "—" : tried.joined(separator: ", "))",
            "",
            last.isEmpty ? "(server neposlal nic)" : last
        ].joined(separator: "\n")
        Store.setSetting("ga4LastDetail", String(detail.prefix(4000)))

        let why: String
        if last.range(of: "\"error\"") != nil {
            why = "odpověděl chybou"
        } else if last.isEmpty {
            why = "neposlal žádná data"
        } else {
            why = "poslal něco, co nejsou čísla návštěvnosti"
        }
        throw BridgeError.message(
            "Sequel \(why). Zkoušeno: \(tried.isEmpty ? "—" : tried.joined(separator: ", "));"
            + " nabízí: \(String(offered.prefix(120))). Celou odpověď ukáže"
            + " „Zobrazit poslední odpověď“ v nastavení.")
    }

    /**
     Čeká napojení na nové přihlášení?

     Když v Sequelu vyprší souhlas s Google účtem, každý dotaz skončí
     `{"action":"reconnect","status":"pending"}`. Bez pojmenování je z toho
     jen záhadná hláška s kusem JSONu — přitom se to spraví jedním klikem.
     */
    private static func needsReconnect(_ text: String) -> String? {
        let pending = text.range(of: "\"status\"\\s*:\\s*\"pending\"",
                                 options: [.regularExpression, .caseInsensitive]) != nil
        let asks = text.range(
            of: "\"action\"\\s*:\\s*\"re[-_]?connect\"|reconnect_url|needs?[-_]?reconnect|re[-_]?authorize",
            options: [.regularExpression, .caseInsensitive]) != nil
        guard pending || asks else { return nil }
        let url = text.range(of: "https?://[^\"'\\s]+", options: .regularExpression)
            .map { String(text[$0]) } ?? "sequel.sh"
        return "Napojení na Google Analytics v Sequelu čeká na nové přihlášení — "
            + "otevři \(url) a povol přístup znovu."
    }

    /**
     Je to seznam spojení místo odpovědi?

     Sequel na špatnou akci ochotně odpoví výpisem napojených zdrojů — a ten
     se pak tvářil jako platná odpověď, ze které vyšlo „0 návštěv".
     */
    private static func looksLikeListing(_ text: String) -> Bool {
        if text.range(of: "\"connections\"\\s*:|\"action\"\\s*:\\s*\"list",
                      options: [.regularExpression, .caseInsensitive]) != nil { return true }
        let hasConnection = text.range(of: "\"connection_?id\"",
                                       options: [.regularExpression, .caseInsensitive]) != nil
        let hasSessions = text.range(of: "\"sessions\"", options: .caseInsensitive) != nil
        return hasConnection && !hasSessions
    }

    /// Hodnoty výčtu ve schématu — `enum`, případně schované v `anyOf`
    private static func enumOf(_ property: Any?) -> [String] {
        guard let one = property as? [String: Any] else { return [] }
        if let values = one["enum"] as? [Any] { return values.map { "\($0)" } }
        if let variants = one["anyOf"] as? [[String: Any]] {
            return variants.flatMap { ($0["enum"] as? [Any] ?? []).map { "\($0)" } }
        }
        return []
    }

    // MARK: - Denní snímek

    /// `YYYY-MM-DD` pro dotaz — Sequel si má vzít přesná data, ne „posledních 30 dní"
    private static func dayKey(_ back: Int) -> String {
        let when = Date().addingTimeInterval(-Double(back) * 86_400)
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: when)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /**
     Zadání pro Sequel.

     Dvě věci, na kterých to poprvé selhalo: **vzorová odpověď se samými
     nulami** (kostra v dotazu je pozvánka ji opsat — a v přehledu pak stálo
     „0 návštěv") a **„posledních 30 dní"**, které si každý vyloží po svém.
     Kostra se proto nepřikládá a data se počítají tady.
     */
    private static func question() -> String {
        let from = dayKey(29)
        let to = dayKey(0)
        let prevFrom = dayKey(59)
        let prevTo = dayKey(30)

        return """
        Spusť v Google Analytics 4 dva reporty a vrať jejich skutečná čísla.

        Období A ("window"): \(from) až \(to).
        Období B ("prevWindow"): \(prevFrom) až \(prevTo).
        U obou období metriky: sessions, totalUsers, transactions (nebo purchases / ecommercePurchases) \
        a purchaseRevenue.
        Dále za období A pět nejsilnějších hodnot dimenze sessionSourceMedium s počtem sessions.

        Odpověz jedním JSONem bez komentáře a bez uvozovacího textu, s klíči:
        window a prevWindow (v každém sessions, users, purchases, revenue) a sources (pole s name a sessions).
        Čísla musí být skutečné hodnoty z reportu — nuly piš jen tam, kde report opravdu vrátil nulu.
        Když se report nepodaří spustit, vrať {"error":"důvod"}.
        """
    }

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
            let text = try await ask(question())
            var parsed: [String: Any] = [:]
            if let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
               let data = String(text[start...end]).data(using: .utf8),
               let one = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                parsed = one
            }

            if let reason = parsed["error"] as? String, !reason.isEmpty {
                throw BridgeError.message("Sequel: \(String(reason.prefix(200)))")
            }

            let window = period(parsed["window"])
            let prev = period(parsed["prevWindow"])
            /*
             Samé nuly nejsou odpověď. Buď se vrátila opsaná kostra dotazu,
             nebo report nic nenašel — v obou případech je poctivější říct,
             že se čísla nepodařilo přečíst, než ukazovat „0 návštěv".
             */
            let anything = ["sessions", "users", "purchases"].contains { key in
                (window[key] as? Int ?? 0) > 0
            }
            if !anything {
                /*
                 Odpověď přišla, ale čísla v ní nejsou — typicky je to návrh,
                 co spustit, ne výsledek. Do bubliny se nevejde, tak se
                 schová celá do nastavení: bez ní se nedá poznat, co po nás
                 Sequel vlastně chce.
                 */
                Store.setSetting("ga4LastDetail",
                                 String(("\(Formats.iso(Date()))\nodpověď bez čísel:\n\(text)").prefix(8000)))
                throw BridgeError.message(
                    "Sequel odpověděl, ale čísla návštěvnosti v tom nejsou — nejspíš vrátil návrh,"
                    + " co spustit. Celou odpověď ukáže „Zobrazit poslední odpověď“ v nastavení.")
            }
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
        /*
         Který web ta čísla měří. GA4 je zatím napojené jen na český web,
         kdežto objednávky chodí ze všech trhů — dělit jedno druhým dá
         nesmysl, tak ať je vidět, co s čím nejde srovnat.
         */
        out["scope"] = Store.setting("ga4Scope", "český web (.cz)") ?? "český web (.cz)"
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
        // Nula není odpověď — hlásí se i to, co přišlo, ať se to dá rozlousknout
        if let sessions = window["sessions"] as? Int, sessions > 0 {
            return "Spojení funguje — za posledních 30 dní \(sessions) návštěv."
        }
        let text = snapshot["text"] as? String ?? ""
        return "Spojení funguje, ale čísla se nepodařilo přečíst. Odpověď: \(text.prefix(200))"
    }
}
