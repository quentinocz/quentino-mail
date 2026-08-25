import Foundation

/// Kolik kódů si zařízení drží zamluvených dopředu.
private let claimAhead = 20

/**
 Jak dlouho musí rezervace ležet, než se z ní smí vydávat. Dvě minuty jsou
 s rezervou nad běžným kolem synchronizace — do té doby se stihne případný
 spor o tentýž kód rozhodnout.
 */
private let claimSettle: TimeInterval = 120

/**
 Šablony dárkových poukazů.

 Šablona drží hodnotu, platnost a jazyk — a k tomu buď jeden pevný kód
 (hromadná akce, všichni dostanou stejný), nebo zásobu unikátních kódů,
 ze které se při každém vložení odebere jeden.

 ── Proč se stejný kód nemůže rozeslat dvakrát ──────────────────────────

 Zásoba kódů je jedna, ale zařízení víc a každé má vlastní databázi; mezi
 sebou se domlouvají jen přes sdílenou složku, tedy se zpožděním. Kdyby
 každé prostě sáhlo po „prvním volném" kódu, dva přístroje by ve stejnou
 chvíli vzaly tentýž. Proto to funguje na tři doby:

 1. **Rezervace předem.** Každé zařízení si při synchronizaci zamluví zásobu
    kódů dopředu (`claimAhead`) a zapíše si k nim své jméno. Vydává pak jen
    ze svých — do cizí rezervy nesáhne.
 2. **Usazení.** Vydává se jen z rezervací starších než `claimSettle`, tedy
    z těch, které už ostatní zařízení viděla a případný spor o ně je dávno
    rozhodnutý (vyhrává dřívější rezervace).
 3. **Vlastní pořadí.** Kdyby rezerva došla a bylo potřeba vydat hned,
    nesáhne zařízení po prvním volném kódu, ale po prvním ve svém vlastním
    pořadí — každé prochází zásobu jinak, takže i tahle nouzová cesta obě
    zařízení rozvede k jinému kódu.

 A kdyby přes to všechno jeden kód vydala dvě zařízení, pozná se to: u kódu
 je zapsané, kdo ho vydal, a synchronizace při rozdílu zapíše to druhé
 vydání do `used_dup`. Aplikace pak na kolizi upozorní, místo aby se potichu
 stalo, že dva zákazníci dostali stejný poukaz.
 */
enum Vouchers {
    static func templates() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT t.*,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id) AS codes_total,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL) AS codes_free,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL AND c.claimed_by = ?) AS codes_mine,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_dup != '') AS codes_dup
            FROM voucher_templates t
            WHERE t.archived = 0
            ORDER BY t.name COLLATE NOCASE
            """,
            [.text(Device.id())]
        )) ?? []
        return rows.map { row -> [String: Any] in
            [
                "id": row["id"] ?? "",
                "name": row["name"] ?? "",
                "value": row["value"] ?? "",
                "unit": row["unit"] ?? "CZK",
                "validUntil": row["valid_until"] ?? "",
                "note": row["note"] ?? "",
                "lang": row["lang"] ?? "cz",
                "codeMode": (row["code_mode"] as? String) == "unique" ? "unique" : "fixed",
                "fixedCode": row["fixed_code"] ?? "",
                "codesTotal": row["codes_total"] ?? 0,
                "codesFree": row["codes_free"] ?? 0,
                "codesMine": row["codes_mine"] ?? 0,
                "codesDup": row["codes_dup"] ?? 0,
                "updatedAt": row["updated_at"] ?? ""
            ]
        }
    }

    static func saveTemplate(_ patch: [String: Any]) throws -> [[String: Any]] {
        let name = (patch["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw BridgeError.message("Šablona musí mít název.") }
        let id = (patch["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString

        try SQLite.shared.run(
            """
            INSERT INTO voucher_templates (id, name, value, unit, valid_until, note, lang,
              code_mode, fixed_code, archived, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,0,?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, value = excluded.value, unit = excluded.unit,
              valid_until = excluded.valid_until, note = excluded.note, lang = excluded.lang,
              code_mode = excluded.code_mode, fixed_code = excluded.fixed_code,
              archived = 0, updated_at = excluded.updated_at
            """,
            [
                .text(id), .text(name),
                .text(patch["value"] as? String ?? ""),
                .text(patch["unit"] as? String ?? "CZK"),
                .text(patch["validUntil"] as? String ?? ""),
                .text(patch["note"] as? String ?? ""),
                .text(patch["lang"] as? String ?? "cz"),
                .text(patch["codeMode"] as? String ?? "fixed"),
                .text((patch["fixedCode"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)),
                .text(Formats.iso())
            ]
        )
        Store.touchState()
        return templates()
    }

    /**
     Smazání je jen příznak. Kdyby se šablona rovnou vymazala, druhé zařízení
     by ji při nejbližší synchronizaci vrátilo zpátky.
     */
    static func deleteTemplate(id: String) -> [[String: Any]] {
        _ = try? SQLite.shared.run(
            "UPDATE voucher_templates SET archived = 1, updated_at = ? WHERE id = ?",
            [.text(Formats.iso()), .text(id)]
        )
        Store.touchState()
        return templates()
    }

    /// Vložený seznam se rozseká po řádcích i čárkách; duplicity se tiše přeskočí.
    static func addCodes(templateId: String, raw: String) -> [String: Any] {
        var seen = Set<String>()
        let codes = raw
            .components(separatedBy: CharacterSet(charactersIn: " \t\n\r,;"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }

        var added = 0
        _ = try? SQLite.shared.transaction {
            for code in codes {
                let result = try SQLite.shared.run(
                    "INSERT OR IGNORE INTO voucher_codes (template_id, code) VALUES (?,?)",
                    [.text(templateId), .text(code)]
                )
                added += result.changes
            }
        }
        // Z čerstvé zásoby si tohle zařízení rovnou ukrojí svůj díl, ať má
        // z čeho vydávat, než doběhne první synchronizace
        _ = claimCodes(templateId: templateId)
        Store.touchState()
        return ["added": added, "skipped": codes.count - added]
    }

    static func codes(templateId: String) -> [[String: Any]] {
        let me = Device.id()
        let rows = (try? SQLite.shared.query(
            """
            SELECT code, used_at, used_for, used_by, claimed_by, used_dup
            FROM voucher_codes WHERE template_id = ? ORDER BY used_at IS NOT NULL, code
            """,
            [.text(templateId)]
        )) ?? []
        return rows.map { row -> [String: Any] in
            let used = row["used_at"] as? String
            let claimed = row["claimed_by"] as? String ?? ""
            return [
                "code": row["code"] ?? "",
                "usedAt": used ?? NSNull(),
                "usedFor": row["used_for"] ?? "",
                "usedBy": row["used_by"] ?? "",
                "claimedElsewhere": used == nil && !claimed.isEmpty && claimed != me,
                "duplicate": row["used_dup"] ?? ""
            ]
        }
    }

    static func deleteCode(templateId: String, code: String) -> [[String: Any]] {
        _ = try? SQLite.shared.run(
            "DELETE FROM voucher_codes WHERE template_id = ? AND code = ?", [.text(templateId), .text(code)]
        )
        Store.touchState()
        return codes(templateId: templateId)
    }

    // MARK: - Rezervace kódů

    /**
     Pořadí, ve kterém tohle zařízení prochází zásobu. Je z jména zařízení a
     kódu, takže je pro každé zařízení jiné, ale pořád stejné — dvě zařízení
     tak sáhnou po jiném kódu, i kdyby to obě dělala v tutéž vteřinu.

     Stačí obyčejný rozptyl znaků: nejde o bezpečnost, jen o to, aby dvě
     zařízení procházela tentýž seznam v jiném pořadí.
     */
    private static func order(_ me: String, _ code: String) -> UInt64 {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in Array("\(me)|\(code)".utf8) {
            hash = (hash ^ UInt64(byte)) &* 0x100000001b3
        }
        return hash
    }

    private static func inMyOrder(_ codes: [String], _ me: String) -> [String] {
        codes.sorted { a, b in
            let (x, y) = (order(me, a), order(me, b))
            return x == y ? a < b : x < y
        }
    }

    /**
     Doplní rezervu zamluvených kódů. Zamlouvá se jen to, co si nedrží nikdo
     jiný — o kód, který má zamluvený druhé zařízení, se nikdo nepere.

     - Returns: kolik kódů přibylo
     */
    @discardableResult
    static func claimCodes(templateId: String, want: Int = claimAhead) -> Int {
        let me = Device.id()
        let mine = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by = ?",
            [.text(templateId), .text(me)]
        ))?.first?["n"] as? Int) ?? 0
        let missing = want - mine
        guard missing > 0 else { return 0 }

        let free = ((try? SQLite.shared.query(
            "SELECT code FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by = '' LIMIT 1000",
            [.text(templateId)]
        )) ?? []).compactMap { $0["code"] as? String }
        guard !free.isEmpty else { return 0 }

        let picked = inMyOrder(free, me).prefix(missing)
        let now = Formats.iso()
        var added = 0
        _ = try? SQLite.shared.transaction {
            for code in picked {
                let result = try SQLite.shared.run(
                    """
                    UPDATE voucher_codes SET claimed_by = ?, claimed_at = ?
                    WHERE template_id = ? AND code = ? AND used_at IS NULL AND claimed_by = ''
                    """,
                    [.text(me), .text(now), .text(templateId), .text(code)]
                )
                added += result.changes
            }
        }
        if added > 0 { Store.touchState() }
        return added
    }

    /// Doplní rezervu u všech šablon se zásobou — volá se před synchronizací.
    @discardableResult
    static func claimAll() -> Int {
        let ids = ((try? SQLite.shared.query(
            "SELECT id FROM voucher_templates WHERE archived = 0 AND code_mode = 'unique'"
        )) ?? []).compactMap { $0["id"] as? String }
        return ids.reduce(0) { $0 + claimCodes(templateId: $1) }
    }

    // MARK: - Vydání kódu

    /**
     Vydání kódu k odeslání. U pevného kódu se nic neodepisuje, u zásoby se
     odebere jeden ze zamluvených — přednost má rezervace, která už se usadila,
     teprve když žádná není, sáhne se do zásoby napřímo (viz úvod souboru).
     */
    static func takeCode(templateId: String, forWhom: String) throws -> (code: String, remaining: Int) {
        guard let template = template(id: templateId) else {
            throw BridgeError.message("Šablona nenalezena.")
        }

        if (template["code_mode"] as? String) != "unique" {
            let fixed = (template["fixed_code"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !fixed.isEmpty else { throw BridgeError.message("Šablona nemá vyplněný kód.") }
            return (fixed, -1)
        }

        let me = Device.id()
        let settledBefore = Formats.iso(Date().addingTimeInterval(-claimSettle))
        let code: String = try SQLite.shared.transaction {
            // 1) usazená vlastní rezervace — bezpečná cesta
            var next = (try SQLite.shared.query(
                """
                SELECT code FROM voucher_codes
                WHERE template_id = ? AND used_at IS NULL AND claimed_by = ? AND claimed_at <= ?
                ORDER BY claimed_at, code LIMIT 1
                """,
                [.text(templateId), .text(me), .text(settledBefore)]
            ).first?["code"]) as? String

            // 2) rezerva došla: vlastní čerstvá rezervace, jinak volný kód — v obou
            //    případech v pořadí tohohle zařízení, aby druhé sáhlo jinam
            if next == nil {
                let free = try SQLite.shared.query(
                    """
                    SELECT code FROM voucher_codes
                    WHERE template_id = ? AND used_at IS NULL AND (claimed_by = '' OR claimed_by = ?) LIMIT 1000
                    """,
                    [.text(templateId), .text(me)]
                ).compactMap { $0["code"] as? String }
                if free.isEmpty {
                    // Zbývat můžou ještě kódy zamluvené jiným zařízením. Vzít je by
                    // bylo přesně to, čemu se tenhle celý mechanismus vyhýbá.
                    let held = (try SQLite.shared.query(
                        "SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL AND claimed_by != ''",
                        [.text(templateId)]
                    ).first?["n"] as? Int) ?? 0
                    throw BridgeError.message(held > 0
                        ? "Volné kódy si drží jiné zařízení. Doplň zásobu v Poukazech."
                        : "Šabloně došly kódy — doplň je v Poukazech.")
                }
                next = inMyOrder(free, me)[0]
            }

            let now = Formats.iso()
            try SQLite.shared.run(
                """
                UPDATE voucher_codes
                SET used_at = ?, used_for = ?, used_by = ?,
                    claimed_by = ?, claimed_at = CASE WHEN claimed_at = '' THEN ? ELSE claimed_at END
                WHERE template_id = ? AND code = ?
                """,
                [
                    .text(now), .text(String(forWhom.prefix(200))), .text(me),
                    .text(me), .text(now), .text(templateId), .text(next!)
                ]
            )
            return next!
        }

        // Rezerva se doplní hned, ne až při synchronizaci — ať je příště z čeho brát
        claimCodes(templateId: templateId)
        let remaining = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL",
            [.text(templateId)]
        ))?.first?["n"] as? Int) ?? 0
        Store.touchState()
        return (code, remaining)
    }

    /// Vrácení kódu do zásoby — když se e-mail nakonec neodeslal.
    static func releaseCode(templateId: String, code: String) {
        // Rezervace zůstává tomuhle zařízení: kód se vrací do vlastní zásoby,
        // ne do společné, takže ho mezitím nikdo jiný nestihne vzít.
        _ = try? SQLite.shared.run(
            """
            UPDATE voucher_codes SET used_at = NULL, used_for = '', used_by = '',
                   claimed_by = ?, claimed_at = ?
            WHERE template_id = ? AND code = ?
            """,
            [.text(Device.id()), .text(Formats.iso()), .text(templateId), .text(code)]
        )
        Store.touchState()
    }

    // MARK: - Kolize

    /**
     Kódy, u kterých se ukázalo, že je vydala dvě zařízení. Za normálních
     okolností prázdné; když ne, je potřeba dát vědět člověku — poukaz už je
     u dvou zákazníků a to za nás aplikace nevyřeší.
     */
    static func clashes() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT c.template_id, c.code, c.used_at, c.used_for, c.used_dup, t.name
            FROM voucher_codes c
            JOIN voucher_templates t ON t.id = c.template_id
            WHERE c.used_dup != ''
            ORDER BY c.used_at DESC
            """
        )) ?? []
        return rows.map { row -> [String: Any] in
            [
                "templateId": row["template_id"] ?? "",
                "templateName": row["name"] ?? "",
                "code": row["code"] ?? "",
                "used": row["used_at"] ?? "",
                "usedFor": row["used_for"] ?? "",
                "duplicate": row["used_dup"] ?? ""
            ]
        }
    }

    /// „Vyřešeno" — člověk se s tím vypořádal, hláška může zmizet.
    static func clearClash(templateId: String, code: String) -> [[String: Any]] {
        _ = try? SQLite.shared.run(
            "UPDATE voucher_codes SET used_dup = '' WHERE template_id = ? AND code = ?",
            [.text(templateId), .text(code)]
        )
        return clashes()
    }

    static func template(id: String) -> [String: Any]? {
        (try? SQLite.shared.query("SELECT * FROM voucher_templates WHERE id = ?", [.text(id)]))?.first
    }

    /// Zadání poukazu poskládané ze šablony — jde rovnou do sazby PDF.
    static func spec(templateId: String, code: String) throws -> [String: Any] {
        guard let template = template(id: templateId) else {
            throw BridgeError.message("Šablona nenalezena.")
        }
        return [
            "codes": [code],
            "value": template["value"] ?? "",
            "unit": template["unit"] ?? "CZK",
            "validUntil": template["valid_until"] ?? "",
            "lang": template["lang"] ?? "cz",
            "note": template["note"] ?? ""
        ]
    }
}
