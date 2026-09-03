import Foundation

/**
 AI nad poštou.

 Pokyny modelu jsou slovo od slova stejné jako na počítači (`src/main/ai.ts`) —
 jinak by odpověď napsaná na telefonu zněla jinak než ta z Macu. Spotřeba
 tokenů se počítá do stejné tabulky, takže přehled sedí bez ohledu na to,
 odkud se psalo.
 */
enum MailAI {
    private static func text(_ row: [String: Any], limit: Int = 6000) -> String {
        let body = row["body_text"] as? String
            ?? (row["body_html"] as? String).map { Mime.snippet(html: $0, text: nil, limit: limit) }
            ?? row["snippet"] as? String
            ?? ""
        return String(body.prefix(limit))
    }

    // MARK: - Shrnutí

    static func summarize(_ dbId: Int) async throws -> String {
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        if let existing = row["summary"] as? String, !existing.isEmpty { return existing }

        let summary = try await AI.ask(
            model: AI.fastModel,
            system: "Shrň e-mail do jedné krátké české věty (max 15 slov). Vystihni, co odesílatel chce "
                + "nebo sděluje. Odpověz jen tou větou, nic víc.",
            user: "Od: \(row["from_name"] as? String ?? "") <\(row["from_addr"] as? String ?? "")>\n"
                + "Předmět: \(row["subject"] as? String ?? "")\n\n\(text(row, limit: 4000))",
            maxTokens: 100
        )
        _ = try? SQLite.shared.run("UPDATE messages SET summary = ? WHERE id = ?",
                               [.text(summary), .int(Int64(dbId))])
        Bridge.notify("messages:changed", ["accountId": row["account_id"] as? Int ?? 0])
        return summary
    }

    // MARK: - Kategorie

    private static let categories = ["orders", "people", "companies", "other"]

    /// Nejdřív uživatelská pravidla (rychlá a zdarma), zbytek dávkou přes model.
    static func categorize(accountId: Int, folder: String, limit: Int = 20) async {
        let rows = (try? SQLite.shared.query(
            """
            SELECT id, subject, from_addr, from_name, snippet FROM messages
            WHERE account_id = ? AND folder = ? AND category IS NULL ORDER BY date DESC LIMIT ?
            """,
            [.int(Int64(accountId)), .text(folder), .int(Int64(limit))]
        )) ?? []
        guard !rows.isEmpty else { return }

        let rules = Store.json("categoryRules", []) as? [[String: Any]] ?? []
        var remaining: [[String: Any]] = []

        for row in rows {
            let match = rules.first { rule in
                let field = rule["field"] as? String ?? "from"
                let haystack = (field == "from"
                    ? "\(row["from_addr"] as? String ?? "") \(row["from_name"] as? String ?? "")"
                    : row["subject"] as? String ?? "").lowercased()
                let needle = (rule["contains"] as? String ?? "").lowercased()
                return !needle.isEmpty && haystack.contains(needle)
            }
            if let match, let category = match["category"] as? String {
                setCategory(category, row["id"] as? Int ?? 0)
            } else {
                remaining.append(row)
            }
        }

        guard !remaining.isEmpty, Secrets.has("anthropicApiKey") else { return }
        let listing = remaining.enumerated().map { index, row in
            "\(index + 1). Od: \(row["from_name"] as? String ?? "") <\(row["from_addr"] as? String ?? "")>"
                + " | Předmět: \(row["subject"] as? String ?? "")"
                + " | Úryvek: \(String((row["snippet"] as? String ?? "").prefix(100)))"
        }.joined(separator: "\n")

        let system = """
        Třídíš příchozí e-maily e-shopu Quentino do kategorií:
        - orders: nové objednávky, potvrzení objednávek, platby, doprava objednávek
        - people: zprávy od koncových zákazníků / fyzických osob (dotazy, reklamace, poděkování)
        - companies: firemní komunikace (dodavatelé, faktury, B2B nabídky, úřady, služby)
        - other: newslettery, spam, automatické notifikace, vše ostatní
        Odpověz POUZE řádky ve tvaru "číslo: kategorie", nic jiného.
        """
        guard let answer = try? await AI.ask(model: AI.fastModel, system: system, user: listing, maxTokens: 1000)
        else { return }

        for line in answer.components(separatedBy: "\n") {
            let parts = line.split(whereSeparator: { $0 == ":" || $0 == "." })
            guard parts.count >= 2, let index = Int(parts[0].trimmingCharacters(in: .whitespaces)) else { continue }
            let category = parts[1].trimmingCharacters(in: .whitespaces).lowercased()
            guard categories.contains(category), index >= 1, index <= remaining.count else { continue }
            setCategory(category, remaining[index - 1]["id"] as? Int ?? 0)
        }
        Bridge.notify("messages:changed", ["accountId": accountId, "folder": folder])
    }

    private static func setCategory(_ category: String, _ dbId: Int) {
        guard dbId > 0 else { return }
        _ = try? SQLite.shared.run("UPDATE messages SET category = ? WHERE id = ?",
                               [.text(category), .int(Int64(dbId))])
    }

    /**
     Automatické zpracování po synchronizaci.

     Když má uživatel vybrané konkrétní kategorie, platí jen ty — obecné
     shrnutí by jinak stejně shrnulo všechno včetně objednávek, které
     uživatel nechtěl.
     */
    static func autoProcess(accountId: Int, folder: String) async {
        guard folder.uppercased() == "INBOX" else { return }
        if Store.bool("autoCategorize", true) {
            await categorize(accountId: accountId, folder: folder)
        }
        guard Secrets.has("anthropicApiKey") else { return }

        let chosen = (Store.json("autoSummarizeCategories", []) as? [String]) ?? []
        let onlyChosen = !chosen.isEmpty

        if Store.bool("autoSummarize", true), !onlyChosen {
            let rows = (try? SQLite.shared.query(
                """
                SELECT id FROM messages WHERE account_id = ? AND folder = ? AND seen = 0
                  AND summary IS NULL AND fetched_full = 1 ORDER BY date DESC LIMIT 5
                """,
                [.int(Int64(accountId)), .text(folder)]
            )) ?? []
            for row in rows { _ = try? await summarize(row["id"] as? Int ?? 0) }
        }

        if onlyChosen {
            let placeholders = chosen.map { _ in "?" }.joined(separator: ",")
            var params: [SQLite.Value] = [.int(Int64(accountId)), .text(folder)]
            params.append(contentsOf: chosen.map { SQLite.Value.text($0) })
            let rows = (try? SQLite.shared.query(
                """
                SELECT id, fetched_full FROM messages
                WHERE account_id = ? AND folder = ? AND summary IS NULL AND category IN (\(placeholders))
                ORDER BY date DESC LIMIT 8
                """,
                params
            )) ?? []
            for row in rows {
                let id = row["id"] as? Int ?? 0
                if (row["fetched_full"] as? Int ?? 0) == 0 {
                    _ = try? await Task.detached(priority: .utility) { try MailSync.fetchFull(id) }.value
                }
                _ = try? await summarize(id)
            }
        }
    }

    // MARK: - Odpověď

    static func reply(_ request: [String: Any]) async throws -> String {
        let dbId = request["messageDbId"] as? Int ?? 0
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        let accountId = row["account_id"] as? Int ?? 0

        let thread = (try? SQLite.shared.query(
            "SELECT * FROM messages WHERE account_id = ? AND thread_key = ? ORDER BY date ASC LIMIT 10",
            [.int(Int64(accountId)), .text(row["thread_key"] as? String ?? "")]
        )) ?? []
        let context = (thread.isEmpty ? [row] : thread).map { message in
            "--- \(message["date"] as? String ?? "") | Od: \(message["from_name"] as? String ?? "") "
                + "<\(message["from_addr"] as? String ?? "")>\n"
                + "Předmět: \(message["subject"] as? String ?? "")\n\(text(message, limit: 2500))"
        }.joined(separator: "\n\n")

        let language = request["language"] as? String ?? "auto"
        let languageRule = language == "cs"
            ? "Odpověď napiš česky."
            : language == "auto"
                ? "Odpověď napiš ve stejném jazyce, v jakém je poslední příchozí zpráva."
                : "Odpověď napiš v jazyce s ISO kódem \"\(language)\"."
        let note = request["note"] as? String ?? ""

        var system = Store.setting("brandPrompt", "") ?? ""
        let orders = await Upgates.contextForAi(email: row["from_addr"] as? String ?? "")
        if !orders.isEmpty {
            system += "\n\n# Objednávky tohoto zákazníka (ŽIVÁ data z e-shopu Upgates — stav, tracking "
                + "a částky z nich můžeš uvádět jako fakta):\n\(orders)"
        }
        let knowledge = knowledgeBlock()
        if !knowledge.isEmpty {
            system += "\n\n# Firemní znalosti (jediný zdroj faktů o podmínkách, kontaktech a procesech):\n\(knowledge)"
        }
        let examples = previousReplies(accountId: accountId, theirAddress: row["from_addr"] as? String ?? "")
        if !examples.isEmpty {
            system += "\n\n# Ukázky našich dřívějších odpovědí (drž se jejich stylu a obvyklých řešení):\n\(examples)"
        }
        system += """


        Tvůj úkol: na základě e-mailového vlákna\(note.isEmpty ? "" : " a stručné poznámky uživatele") napiš \
        kompletní, zdvořilou odpověď v celých větách a se správnou strukturou (oslovení, tělo, závěr). \(languageRule)
        Pravidla: Nepiš předmět. Nepřidávej podpis (doplní se automaticky). Nepoužívej zástupné texty \
        v hranatých závorkách. Fakta (doprava, termíny, ceny, podmínky) čerpej výhradně z vlákna \
        a firemních znalostí — nic si nedomýšlej. Odpověz POUZE textem e-mailu.
        """

        return try await AI.ask(
            model: AI.draftModel,
            system: system,
            user: "E-mailové vlákno:\n\(context)\n\nPoznámka uživatele (co má odpověď sdělit): "
                + (note.isEmpty
                    ? "Vhodně a vstřícně odpověz na poslední zprávu; využij firemní znalosti, pokud jsou relevantní."
                    : note),
            maxTokens: 1500
        )
    }

    /// Kontaktní údaje a nahrané dokumenty (podmínky, reklamační řád…).
    private static func knowledgeBlock() -> String {
        var out = ""
        let contact = (Store.setting("contactInfo", "") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !contact.isEmpty { out += "## Kontaktní údaje firmy\n\(contact)\n\n" }
        for document in Settings.knowledge() {
            out += "## \(document["title"] as? String ?? "")\n"
                + String((document["content"] as? String ?? "").prefix(2500)) + "\n\n"
            if out.count > 9000 { break }
        }
        return String(out.prefix(10000))
    }

    /// Poslední odeslané odpovědi — vzor stylu a obvyklých řešení.
    private static func previousReplies(accountId: Int, theirAddress: String) -> String {
        guard let account = MailStore.accountRow(accountId), let email = account["email"] as? String else { return "" }
        let rows = (try? SQLite.shared.query(
            """
            SELECT subject, body_text FROM messages
            WHERE account_id = ? AND from_addr = ? AND body_text IS NOT NULL AND body_text != ''
            ORDER BY CASE WHEN to_addr LIKE ? THEN 0 ELSE 1 END, date DESC LIMIT 3
            """,
            [.int(Int64(accountId)), .text(email), .text("%\(theirAddress)%")]
        )) ?? []
        return rows.map {
            "Předmět: \($0["subject"] as? String ?? "")\n"
                + String(($0["body_text"] as? String ?? "").prefix(800))
        }.joined(separator: "\n---\n")
    }

    // MARK: - Překlad příchozí zprávy

    static func translateIncoming(_ dbId: Int) async throws -> [String: Any] {
        guard let row = MailStore.row(dbId) else { throw BridgeError.message("Zpráva nenalezena.") }
        if let language = row["detected_lang"] as? String, let translation = row["translation_cz"] as? String,
           !language.isEmpty {
            return ["lang": language, "translation": translation]
        }

        let answer = try await AI.ask(
            model: AI.fastModel,
            system: """
            Na prvním řádku vrať ISO 639-1 kód jazyka textu (např. "en", "de", "cs").
            Pokud je text česky nebo slovensky, na druhý řádek napiš jen "SKIP".
            Jinak od druhého řádku dál napiš věrný český překlad celého textu. Žádné komentáře.
            """,
            user: "Předmět: \(row["subject"] as? String ?? "")\n\n\(text(row, limit: 5000))",
            maxTokens: 2000
        )

        let lines = answer.components(separatedBy: "\n")
        let language = String((lines.first ?? "").trimmingCharacters(in: .whitespaces).lowercased().prefix(5))
        let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let translation = rest == "SKIP" ? "" : rest

        _ = try? SQLite.shared.run(
            "UPDATE messages SET detected_lang = ?, translation_cz = ? WHERE id = ?",
            [.text(language), .text(translation), .int(Int64(dbId))]
        )
        return ["lang": language, "translation": translation]
    }

    static func translateHtml(_ html: String, to language: String) async throws -> String {
        try await AI.ask(
            model: AI.draftModel,
            system: "Přelož text e-mailu do jazyka s ISO kódem \"\(language)\". Vstup může obsahovat jednoduché "
                + "HTML značky — zachovej je beze změny, přelož pouze text. Vrať POUZE přeložený obsah.",
            user: html,
            maxTokens: 2500
        )
    }
}
