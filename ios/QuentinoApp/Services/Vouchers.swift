import Foundation

/**
 Šablony dárkových poukazů.

 Šablona drží hodnotu, platnost a jazyk — a k tomu buď jeden pevný kód
 (hromadná akce, všichni dostanou stejný), nebo zásobu unikátních kódů,
 ze které se při každém vložení odebere jeden.

 Kódy se odepisují v transakci a odepsání se pozná i na druhém zařízení
 (synchronizace slučuje použití, ne poslední stav), takže se stejný kód
 nerozešle dvakrát.
 */
enum Vouchers {
    static func templates() -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            """
            SELECT t.*,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id) AS codes_total,
                   (SELECT COUNT(*) FROM voucher_codes c WHERE c.template_id = t.id AND c.used_at IS NULL) AS codes_free
            FROM voucher_templates t
            WHERE t.archived = 0
            ORDER BY t.name COLLATE NOCASE
            """
        )) ?? []
        return rows.map { row in
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
        try? SQLite.shared.run(
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
        try? SQLite.shared.transaction {
            for code in codes {
                let result = try SQLite.shared.run(
                    "INSERT OR IGNORE INTO voucher_codes (template_id, code) VALUES (?,?)",
                    [.text(templateId), .text(code)]
                )
                added += result.changes
            }
        }
        Store.touchState()
        return ["added": added, "skipped": codes.count - added]
    }

    static func codes(templateId: String) -> [[String: Any]] {
        let rows = (try? SQLite.shared.query(
            "SELECT code, used_at, used_for FROM voucher_codes WHERE template_id = ? ORDER BY used_at IS NOT NULL, code",
            [.text(templateId)]
        )) ?? []
        return rows.map { row in
            ["code": row["code"] ?? "", "usedAt": row["used_at"] ?? NSNull(), "usedFor": row["used_for"] ?? ""]
        }
    }

    static func deleteCode(templateId: String, code: String) -> [[String: Any]] {
        try? SQLite.shared.run(
            "DELETE FROM voucher_codes WHERE template_id = ? AND code = ?", [.text(templateId), .text(code)]
        )
        Store.touchState()
        return codes(templateId: templateId)
    }

    /**
     Vydání kódu k odeslání. U pevného kódu se nic neodepisuje, u zásoby se
     odebere nejstarší nepoužitý — obojí v jedné transakci, aby dvě rychlá
     klepnutí nevydala stejný kód.
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

        let code: String = try SQLite.shared.transaction {
            let rows = try SQLite.shared.query(
                """
                SELECT code FROM voucher_codes WHERE template_id = ? AND used_at IS NULL
                ORDER BY created_at, code LIMIT 1
                """,
                [.text(templateId)]
            )
            guard let next = rows.first?["code"] as? String else {
                throw BridgeError.message("Šabloně došly kódy — doplň je v Poukazech.")
            }
            try SQLite.shared.run(
                "UPDATE voucher_codes SET used_at = ?, used_for = ? WHERE template_id = ? AND code = ?",
                [.text(Formats.iso()), .text(String(forWhom.prefix(200))), .text(templateId), .text(next)]
            )
            return next
        }

        let remaining = ((try? SQLite.shared.query(
            "SELECT COUNT(*) AS n FROM voucher_codes WHERE template_id = ? AND used_at IS NULL",
            [.text(templateId)]
        ))?.first?["n"] as? Int) ?? 0
        Store.touchState()
        return (code, remaining)
    }

    /// Vrácení kódu do zásoby — když se e-mail nakonec neodeslal.
    static func releaseCode(templateId: String, code: String) {
        try? SQLite.shared.run(
            "UPDATE voucher_codes SET used_at = NULL, used_for = '' WHERE template_id = ? AND code = ?",
            [.text(templateId), .text(code)]
        )
        Store.touchState()
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
