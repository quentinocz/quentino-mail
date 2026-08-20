import Foundation

/**
 Zařazení hlášky dopravce do fáze, aby šlo na první pohled poznat, kde zásilka
 je — bez čtení věty.

 Pořadí je stejné jako na počítači a je záměrné: pravidla (zadarmo) → naučené
 z databáze (zadarmo) → AI (jen jednou pro každou novou podobu hlášky).

 Hlášky se liší hlavně tím, že v sobě mají název depa nebo pobočky („Zásilka
 dorazila na depo Ostrava, Františka a Anny Ryšových 1300/44"), takže se před
 porovnáním odstraní vlastní jména a čísla a zůstane jen kostra věty. Stejná
 hláška z jiného města tak spadne do stejné fáze bez jediného dotazu na AI.
 */
enum ShipPhase {
    /// Fáze, které umí rozhodnout pravidla i AI; cokoliv jiného je `unknown`.
    static let known = ["pending", "transit", "ready", "delivered", "problem"]
    static let unknown = "unknown"

    /// Pořadí rozhoduje: první shoda vyhrává. Nejjednoznačnější napřed —
    /// „připraveno k vyzvednutí" obsahuje i „doruč", takže by se jinak chytlo
    /// jako doručeno.
    private static let rules: [(phase: String, pattern: String)] = [
        ("problem", #"nedoru[čc]|nepoda[řr]ilo\s+(se\s+)?doru[čc]|nezasti[žz]|vr[áa]c|vr[áa]t[ií]|storn|zru[šs]|po[šs]kozen|zpo[žz]d|ztrac|reklamac|nevyzvednut|odm[íi]tn|returned|failed|damaged|lost|refus"#),
        ("ready", #"p[řr]ipraven[aoáe]?\s*k\s*(vyzvednut|p[řr]evzet)|k\s*vyzvednut[ íi]|ready\s*(for|to)\s*(pick|collect)|\bulo[žz]en[aoáe]?\b.*\b(v[ýy]dejn|po[bš]|z-?box)"#),
        ("delivered", #"doru[čc]en|vyzvednut|p[řr]edan[aoáe]?\s*p[řr][íi]jemc|je\s*u\s*v[áa]s|delivered|picked\s*up|collected"#),
        ("transit", #"na\s*cest|v\s*p[řr]eprav|do\s*p[řr]eprav|p[řr]eprav|depo|dep[óo]|t[řr][íi]d[íi]c|rozv[áa]|doru[čc]ova|v\s*ruk[áa]ch\s*[řr]idi[čc]|p[řr]evzal|p[řr]evzat[íi]|pod[áa]n|p[řr]ed[áa]n[oa]?\s*(k|do|dopravc|p[řr]epravc)|in\s*transit|out\s*for\s*delivery|on\s*the\s*way|shipped|dispatch|handed\s*over"#),
        ("pending", #"[čc]ek[áa]me|o\s*va[šs][íi]\s*z[áa]silce\s*u[žz]\s*v[íi]me|nep[řr]edan|p[řr]ipravuje\s*se\s*k\s*p[řr]ed[áa]n|awaiting|label\s*created|pre-?advice|registrov|o[čc]ek[áa]v[áa]me"#)
    ]

    // MARK: - Pravidla a kostra hlášky

    /**
     Kostra hlášky bez konkrétních míst a čísel — na ní se pozná, že jde
     o tutéž hlášku z jiné pobočky.

     Názvy měst, dep a poboček začínají velkým písmenem; bez nich je z hlášky
     „Zásilka dorazila na depo Ostrava…" a „…depo Holubice…" tatáž věta, takže
     se na AI ptáme jednou za formulaci, ne jednou za pobočku. První slovo se
     nechává vždycky — věta jím běžně začíná („Zásilka…").
     */
    static func skeleton(_ text: String) -> String {
        let words = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let generic = words.enumerated().filter { item -> Bool in
            guard let first = item.element.first else { return false }
            if item.offset == 0 { return true }
            if first.isNumber { return true }
            // Malé písmeno se změní převodem na velké; u velkého a u interpunkce ne
            return String(first).uppercased() != String(first)
        }
        .map { $0.element }

        // Diakritika pryč (schválně s POSIX locale, ať se nic „národního" nešetří),
        // pak zůstanou jen písmena — čísla popisná, PSČ i interpunkce se rozpadnou
        // na mezery. Dvanáct slov bohatě stačí, delší konce vět bývají jen omáčka.
        let folded = generic.joined(separator: " ")
            .lowercased()
            .folding(options: [.diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        let letters = String(folded.map { $0.isLetter ? $0 : " " })

        return letters.split(separator: " ")
            .map(String.init)
            .filter { $0.count > 1 }
            .prefix(12)
            .joined(separator: " ")
    }

    /// Rozhodnutí podle pravidel; `nil` = pravidla hlášku neznají.
    static func byRules(_ text: String) -> String? {
        for rule in rules where matches(rule.pattern, text) {
            return rule.phase
        }
        return nil
    }

    // MARK: - Zařazení

    /// Zařadí hlášku do fáze. Bez API klíče (nebo když AI neodpoví) zůstane
    /// hláška nezařazená a karta ji ukáže jen jako text.
    static func classify(_ text: String?) async -> String {
        let value = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return unknown }

        if let byRules = byRules(value) { return byRules }

        let key = skeleton(value)
        guard !key.isEmpty else { return unknown }
        if let learned = learned(key) { return learned }

        guard Secrets.has("anthropicApiKey") else { return unknown }

        // Malý model a dvanáct tokenů: odpověď je jediné slovo, delší strop by
        // jen svedl model k vysvětlování.
        let system = "Zařaď hlášku dopravce o stavu zásilky do jedné z fází."
            + " Odpověz výhradně jedním slovem z této nabídky: \(known.joined(separator: ", "))."
        let user = """
        Hláška: "\(value)"

        Fáze:
        pending = čeká na předání dopravci
        transit = je v přepravě, na cestě
        ready = připravena k vyzvednutí
        delivered = doručena nebo vyzvednuta
        problem = nedoručeno, vráceno, storno, poškození, zpoždění
        """

        guard let raw = try? await AI.ask(model: AI.fastModel, system: system, user: user, maxTokens: 12) else {
            return unknown
        }
        // Model rád přidá tečku nebo uvozovky; zbydou jen písmena
        let answer = String(raw.lowercased().filter { $0.isLetter && $0.isASCII })
        guard known.contains(answer) else { return unknown }

        remember(skeleton: key, sample: value, phase: answer, source: "ai")
        return answer
    }

    /// Ruční oprava zařazení (kanál `ship:relearn`) — uloží se stejně jako
    /// odpověď AI, jen se zdrojem `user`, ať je poznat, co opravil člověk.
    static func relearn(text: String, phase: String) {
        let key = skeleton(text)
        guard !key.isEmpty else { return }
        remember(skeleton: key, sample: text, phase: phase, source: "user")
    }

    // MARK: - Naučené hlášky

    /**
     Tabulka `ship_phase` v iOS schématu zatím není (učení běželo jen na
     počítači), proto se zakládá při prvním použití. Sloupce se drží desktopu,
     aby záloha z počítače sedla i sem a naopak.
     */
    private static let table: Bool = {
        SQLite.shared.exec(
            """
            CREATE TABLE IF NOT EXISTS ship_phase (
              skeleton TEXT PRIMARY KEY,
              phase TEXT NOT NULL,
              sample TEXT NOT NULL DEFAULT '',
              source TEXT NOT NULL DEFAULT 'ai',
              at TEXT NOT NULL
            );
            """
        )
    }()

    private static func learned(_ skeleton: String) -> String? {
        _ = table
        let rows = (try? SQLite.shared.query(
            "SELECT phase FROM ship_phase WHERE skeleton = ?",
            [.text(skeleton)]
        )) ?? []
        return rows.first?["phase"] as? String
    }

    private static func remember(skeleton: String, sample: String, phase: String, source: String) {
        _ = table
        // Uložení je jen optimalizace — když selže, jen se příště zeptáme znovu.
        // Ukázka se ořezává, ať v databázi nekyne celý odstavec od dopravce.
        _ = try? SQLite.shared.run(
            """
            INSERT INTO ship_phase (skeleton, phase, sample, source, at) VALUES (?,?,?,?,?)
            ON CONFLICT(skeleton) DO UPDATE SET
              phase = excluded.phase, source = excluded.source, at = excluded.at
            """,
            [.text(skeleton), .text(phase), .text(String(sample.prefix(200))), .text(source), .text(Formats.iso())]
        )
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
