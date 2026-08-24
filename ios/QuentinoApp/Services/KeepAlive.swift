import Foundation

/**
 Aby projekty Supabase neusnuly.

 Totéž, co na počítači dělá `src/main/keepalive.ts`. Bezplatný tarif projekt
 po několika dnech bez jediného dotazu uspí a probrat ho jde jen ručně
 v administraci. Do té doby nefunguje to, co na něm visí: u chatu zákazník
 píše do prázdna, u Instagramu spadne publikace, protože fotku není kam nahrát.

 Aplikace používá **dva** projekty a každý jinak často. Chat se čte každou
 chvíli, dokud aplikace běží, takže se prakticky udržuje sám. Úložiště médií
 se ozve jen při publikaci příspěvku — mezi dvěma příspěvky uplyne klidně
 týden, takže je na uspání náchylnější.

 Můžou to být i dva různé projekty, jeden společný, nebo jen jeden z nich
 nastavený. Proto se nepočítá „chat" a „Instagram", ale **hostitel**: když
 obojí ukazuje na tentýž projekt, oťuká se jednou a hlásí se jednou.
 */
enum KeepAlive {
    /// Po kolika dnech ticha má smysl sáhnout na projekt sám od sebe.
    private static let quietDays = 1.0

    /// Kdy začít varovat. Supabase uspává kolem týdne, tohle nechává rezervu.
    static let warnDays = 4

    struct Project {
        var host: String
        var url: String
        var uses: [String]
        var key: String
        /// Cesta, která projekt jen oťukne a nic nezmění
        var probe: String
    }

    private static func host(_ url: String) -> String {
        URL(string: url)?.host?.lowercased() ?? url.lowercased()
    }

    static func projects() -> [Project] {
        var found: [String: Project] = [:]
        var order: [String] = []

        func add(_ url: String, _ key: String, _ use: String, _ probe: String) {
            guard !url.isEmpty, !key.isEmpty else { return }
            let id = host(url)
            if var existing = found[id] {
                if !existing.uses.contains(use) { existing.uses.append(use) }
                found[id] = existing
                return
            }
            found[id] = Project(
                host: id,
                url: url.replacingOccurrences(of: "/+$", with: "", options: .regularExpression),
                uses: [use], key: key, probe: probe
            )
            order.append(id)
        }

        // Dotaz na jeden řádek je to nejlacinější, co projekt probudí
        add(Store.setting("chatSupabaseUrl", "") ?? "", Secrets.get("chatAnonKey") ?? "",
            "chat", "/rest/v1/conversations?select=id&limit=1")
        // Úložiště nemá REST tabulky — výpis kbelíků je jeho obdoba
        add(Store.setting("igStorageUrl", "") ?? "", Secrets.get("igStorageKey") ?? "",
            "média pro Instagram", "/storage/v1/bucket")

        return order.compactMap { found[$0] }
    }

    // MARK: - Kdy se který ozval

    private static func seenKey(_ id: String) -> String { "supabaseSeen:\(id)" }

    static func markSeen(_ url: String) {
        guard !url.isEmpty else { return }
        Store.setSetting(seenKey(host(url)), ISO8601DateFormatter().string(from: Date()))
    }

    static func lastSeen(_ url: String) -> String {
        url.isEmpty ? "" : (Store.setting(seenKey(host(url)), "") ?? "")
    }

    /// Kolik dní je projekt bez ozvání; `-1` = neozval se nikdy.
    static func idleDays(_ url: String) -> Int {
        let at = lastSeen(url)
        guard !at.isEmpty, let date = ISO8601DateFormatter().date(from: at) else { return -1 }
        return max(0, Int(Date().timeIntervalSince(date) / 86_400))
    }

    // MARK: - Oťukání

    private static func ping(_ project: Project) async throws {
        _ = try await Http.request(
            project.url + project.probe,
            headers: ["apikey": project.key, "Authorization": "Bearer \(project.key)"],
            timeout: 20
        )
    }

    /// Oťuká projekty, které se delší dobu neozvaly.
    @discardableResult
    static func keepAwake(force: Bool = false) async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for project in projects() {
            let idle = Double(idleDays(project.url))
            if !force && idle >= 0 && idle < quietDays { continue }
            do {
                try await ping(project)
                markSeen(project.url)
                out.append(["host": project.host, "uses": project.uses, "ok": true])
            } catch {
                // Zamítnutí je taky odpověď — projekt běží. Vadí až ticho.
                let message = error.localizedDescription
                let refused = message.range(of: "40[0-9]", options: .regularExpression) != nil
                if refused { markSeen(project.url) }
                out.append(["host": project.host, "uses": project.uses,
                            "ok": refused, "error": refused ? "" : message])
            }
        }
        return out
    }

    /// Přehled pro nastavení: co je nastavené a jak dlouho je od každého ticho.
    static func status() -> [[String: Any]] {
        projects().map { project in
            let idle = idleDays(project.url)
            return [
                "host": project.host,
                "uses": project.uses,
                "lastSeen": lastSeen(project.url),
                "idleDays": idle,
                "warn": idle >= warnDays
            ]
        }
    }
}
